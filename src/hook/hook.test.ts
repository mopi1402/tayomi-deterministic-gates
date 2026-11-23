import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { judge } from "../core/send-back.ts";
import { git, outcome, ran, tempRepo } from "../testing.ts";
import { handleHook, type HookOutput, parseHookInput, stopOutput } from "./hook.ts";

const CLI = join(import.meta.dirname, "..", "cli.ts");

const FAILING_GATE = JSON.stringify({
  gates: [{ name: "fail", severity: "error", files: "\\.ts$", run: ["false"] }],
});

/**
 * One agent session over several folders, with the events as Codex sends them: Claude Code sends a subset of the
 * same fields.
 */
function session() {
  const id = `test-${randomUUID()}`;
  const folders: string[] = [];
  const folder = () => {
    const path = mkdtempSync(join(tmpdir(), "gates-hook-"));
    folders.push(path);
    return path;
  };
  const event = (name: string, cwd: string, fields: object) =>
    JSON.stringify({
      session_id: id,
      transcript_path: "/t",
      cwd,
      hook_event_name: name,
      model: "m",
      turn_id: "t",
      ...fields,
    });
  return {
    folder,
    /** A repo whose gate fails on any changed .ts file. */
    repo: (gates: string | undefined = FAILING_GATE) => {
      const path = tempRepo();
      folders.push(path);
      writeFileSync(join(path, "fail.mjs"), "process.exit(1)");
      if (gates !== undefined) writeFileSync(join(path, ".gates.json"), gates);
      return path;
    },
    start: (cwd: string, source: string) => handleHook("session-start", event("SessionStart", cwd, { source })),
    prompt: (cwd: string) => handleHook("turn-start", event("UserPromptSubmit", cwd, { prompt: "hi" })),
    stop: (cwd: string, retry = false, said = "") =>
      handleHook("check", event("Stop", cwd, { stop_hook_active: retry, last_assistant_message: said })),
    end: (cwd: string) => handleHook("session-end", event("SessionEnd", cwd, { reason: "other" })),
    cleanup: () => {
      for (const path of folders) rmSync(path, { recursive: true, force: true });
    },
  };
}

describe("parseHookInput", () => {
  test("keeps the fields it knows, with their types, and nothing from text it cannot read", () => {
    const text = '{"session_id":"s","stop_hook_active":true,"cwd":"/r","last_assistant_message":"done","other":1}';
    assert.deepEqual(parseHookInput(text), {
      session_id: "s",
      stop_hook_active: true,
      cwd: "/r",
      last_assistant_message: "done",
    });
    assert.deepEqual(parseHookInput('{"session_id":3}'), {});
    assert.deepEqual(parseHookInput("not json"), {});
  });
});

describe("stopOutput", () => {
  // A first stop of a turn, with no waive line.
  const firstStop = (turn: ReturnType<typeof ran>) => stopOutput(turn, judge(turn, [], ["lint", "dead", "tests"], 5));

  test("only shows the summary when every gate passes", () => {
    const output = firstStop(ran([outcome("lint", true)]));
    assert.equal(output.decision, undefined);
    assert.ok(output.systemMessage);
  });

  test("sends the agent back with the reports of the failed gates, and how to waive one", () => {
    const output = firstStop(ran([outcome("lint", false), outcome("dead", true)]));
    assert.equal(output.decision, "block");
    assert.match(output.reason ?? "", /## lint\nlint report/);
    assert.match(output.reason ?? "", /^\[deterministic-gates:<gate>\]: waive "<reason>"$/m);
    assert.match(output.reason ?? "", /This is send-back 1 of 5\./);
    assert.match(stripVTControlCharacters(output.systemMessage), /the agent is sent back to fix it \(1 of 5\)/);
  });

  test("never sends the agent back for a gate out of time, and shows it apart from the green and the red", () => {
    const late = { ...outcome("tests", false), timedOut: true };
    const output = firstStop(ran([outcome("lint", true), late]));
    assert.equal(output.decision, undefined);
    assert.match(stripVTControlCharacters(output.systemMessage), /1\/2 gates green in .* · 1 out of time/);
    assert.match(stripVTControlCharacters(output.systemMessage), /⏱ tests/);
    const both = firstStop(ran([outcome("lint", false), late]));
    assert.equal(both.decision, "block");
    assert.doesNotMatch(both.reason ?? "", /## tests/);
  });

  test("shows a waived gate in its own colour with the reason under it, and hands back", () => {
    const turn = ran([outcome("lint", false), outcome("dead", true)]);
    const output = stopOutput(turn, judge(turn, [{ gate: "lint", reason: "kept as asked" }], ["lint", "dead"], 5));
    assert.equal(output.decision, undefined);
    const lines = stripVTControlCharacters(output.systemMessage).split("\n");
    assert.match(lines[0] ?? "", /1\/2 gates green in .* · 1 waived$/);
    assert.match(lines[1] ?? "", /^\u26A0\uFE0E lint /);
    assert.equal(lines[2], "  * kept as asked");
    assert.match(output.systemMessage, /\x1b\[1;38;5;208m/);
  });
});

describe("handleHook", () => {
  let agent: ReturnType<typeof session>;

  beforeEach(() => {
    agent = session();
  });

  afterEach(() => {
    agent.cleanup();
  });

  test("does nothing outside git, or in a repo with no gates file, at the prompt as at the stop", async () => {
    const folder = agent.folder();
    assert.equal(await agent.prompt(folder), undefined);
    assert.equal(await agent.stop(folder), undefined);
    git(folder, ["init", "--quiet"]);
    assert.equal(await agent.prompt(folder), undefined);
    assert.equal(await agent.stop(folder), undefined);
    writeFileSync(join(folder, ".gates.json"), JSON.stringify({ gates: [] }));
    assert.ok(await agent.stop(folder));
  });

  test("checks the repo the turn started in, whatever folder the agent stops in, its retry included", async () => {
    const started = agent.repo();
    const elsewhere = agent.repo();
    await agent.prompt(started);
    writeFileSync(join(started, "a.ts"), "1");
    assert.equal((await agent.stop(elsewhere))?.decision, "block");
    assert.match((await agent.stop(elsewhere, true))?.systemMessage ?? "", /sent back to fix it \(2 of 5\)/);
  });

  test("checks the folder the agent stops in, when no turn is in progress", async () => {
    const started = agent.repo();
    const elsewhere = agent.repo();
    await agent.prompt(started);
    await agent.stop(started);
    assert.match((await agent.stop(elsewhere))?.systemMessage ?? "", /no turn start recorded/);
  });

  test("checks the repo the agent stops in, after a prompt from a folder with no gates", async () => {
    const interrupted = agent.repo();
    const plain = agent.folder();
    const stopped = agent.repo();
    await agent.prompt(interrupted);
    await agent.prompt(plain);
    writeFileSync(join(stopped, "b.ts"), "1");
    assert.equal((await agent.stop(stopped))?.decision, "block");
  });

  // A turn interrupted in one repo, a whole turn in another, then a prompt back in the first.
  async function resumedAfterAnotherRepo(): Promise<string> {
    const interrupted = agent.repo();
    const other = agent.repo();
    await agent.prompt(interrupted);
    writeFileSync(join(interrupted, "a.ts"), "1");
    await agent.prompt(other);
    await agent.stop(other);
    await agent.prompt(interrupted);
    return interrupted;
  }

  test("checks an interrupted turn with the next turn of its repo, even after a turn in another repo", async () => {
    const interrupted = await resumedAfterAnotherRepo();
    assert.equal((await agent.stop(interrupted))?.decision, "block");
  });

  test("checks a resumed turn in its repo, whatever folder the agent stops in", async () => {
    await resumedAfterAnotherRepo();
    assert.equal((await agent.stop(agent.folder()))?.decision, "block");
  });

  test("never follows a checked turn into a retry of another one", async () => {
    const checked = agent.repo();
    const plain = agent.folder();
    const stopped = agent.repo();
    await agent.prompt(checked);
    await agent.stop(checked);
    await agent.prompt(plain);
    writeFileSync(join(stopped, "b.ts"), "1");
    // Another plugin's stop hook can block, so a retry may be the first stop the engine sees of a turn.
    assert.match(stripVTControlCharacters((await agent.stop(stopped, true))?.systemMessage ?? ""), /✗ fail/);
  });

  test("checks a turn with the gates it started with, even after the agent deleted the gates file", async () => {
    const repo = agent.repo();
    await agent.prompt(repo);
    rmSync(join(repo, ".gates.json"));
    writeFileSync(join(repo, "a.ts"), "1");
    assert.equal((await agent.stop(repo))?.decision, "block");
  });

  test("tells the owner at the stop too, when the gates of the repo the prompt came from cannot run", async () => {
    const interrupted = agent.repo();
    const unreadable = agent.repo("{");
    await agent.prompt(interrupted);
    await agent.prompt(unreadable);
    assert.match((await agent.stop(unreadable))?.systemMessage ?? "", /could not run/);
  });

  test("tells only the owner why the gates cannot run, instead of crashing", async () => {
    const unreadable = agent.repo("{");
    for (const output of [await agent.prompt(unreadable), await agent.stop(unreadable)]) {
      assert.equal(output?.decision, undefined);
      assert.match(output?.systemMessage ?? "", /could not run: \.gates\.json is not valid JSON/);
    }
  });

  describe("a gate whose tool this machine does not have", () => {
    const gates = JSON.stringify({
      gates: [
        { name: "lint", severity: "error", files: "\\.ts$", run: ["no-such-tool", "{files}"] },
        { name: "fail", severity: "error", files: "\\.ts$", run: ["false"] },
      ],
    });

    test("asks the agent once to install the tool, and tells the owner which gate is off", async () => {
      const repo = agent.repo(gates);
      const asked = await agent.prompt(repo);
      assert.match(asked?.hookSpecificOutput?.additionalContext ?? "", /- lint: no-such-tool is not installed/);
      assert.match(asked?.hookSpecificOutput?.additionalContext ?? "", /stay off until they are installed/);
      assert.match(stripVTControlCharacters(asked?.systemMessage ?? ""), /1 gate is off, a tool is missing/);
      assert.equal(await agent.prompt(repo), undefined);
    });

    test("asks again once the session starts again or resumes, never after a compaction", async () => {
      const repo = agent.repo(gates);
      await agent.prompt(repo);
      await agent.start(repo, "compact");
      assert.equal(await agent.prompt(repo), undefined);
      await agent.start(repo, "resume");
      assert.ok((await agent.prompt(repo))?.hookSpecificOutput);
    });

    test("asks again when the list of missing tools changes", async () => {
      const repo = agent.repo(gates);
      await agent.prompt(repo);
      const more = JSON.parse(gates) as { gates: object[] };
      more.gates.push({ name: "types", severity: "error", files: "\\.ts$", run: ["no-other-tool"] });
      writeFileSync(join(repo, ".gates.json"), JSON.stringify(more));
      assert.match((await agent.prompt(repo))?.hookSpecificOutput?.additionalContext ?? "", /- types: no-other-tool/);
    });

    test("sends the agent back for the gates that ran, never for the one that could not", async () => {
      const repo = agent.repo(gates);
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "1");
      const stopped = await agent.stop(repo);
      assert.equal(stopped?.decision, "block");
      assert.match(stopped?.reason ?? "", /^## fail$/m);
      assert.doesNotMatch(stopped?.reason ?? "", /^## lint$/m);
      assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), /lint not run: no-such-tool/);
    });
  });

  describe("a turn that sends the agent back until each red gate is fixed or waived", () => {
    // Fails, saying what the file holds, while the file it is given exists.
    const RED_IF = [
      'import { existsSync, readFileSync } from "node:fs";',
      'const [, , file = ""] = process.argv;',
      "if (existsSync(file)) {",
      "  console.log(`problem in ${file}: ${readFileSync(file, 'utf8')}`);",
      "  process.exit(1);",
      "}",
    ].join("\n");

    // Gate a fails while a.bad exists, gate b while b.bad does.
    async function turn(settings: object = {}): Promise<string> {
      const gates = ["a", "b"].map((name) => ({
        name,
        severity: "error",
        files: "\\.bad$",
        run: ["red-if.mjs", `${name}.bad`],
      }));
      const repo = agent.repo(JSON.stringify({ gates, ...settings }));
      writeFileSync(join(repo, "red-if.mjs"), RED_IF);
      await agent.prompt(repo);
      return repo;
    }

    const waive = (gate: string, reason: string) => `I leave it.\n\n[deterministic-gates:${gate}]: waive "${reason}"`;
    const shown = (output: { systemMessage?: string } | undefined) =>
      stripVTControlCharacters(output?.systemMessage ?? "");

    test("sends the agent back again while a gate it did not waive stays red", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      assert.equal((await agent.stop(repo))?.decision, "block");
      const again = await agent.stop(repo, true);
      assert.equal(again?.decision, "block");
      assert.match(again?.reason ?? "", /This is send-back 2 of 5\./);
    });

    test("catches a fix that breaks another gate, still from the turn start", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      await agent.stop(repo);
      rmSync(join(repo, "a.bad"));
      writeFileSync(join(repo, "b.bad"), "x");
      const again = await agent.stop(repo, true);
      assert.equal(again?.decision, "block");
      assert.match(again?.reason ?? "", /^## b$/m);
      assert.doesNotMatch(again?.reason ?? "", /^## a$/m);
    });

    test("hands back once the agent waives the red gate, and shows the owner why", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      await agent.stop(repo);
      const handed = await agent.stop(repo, true, waive("a", "kept as you asked"));
      assert.equal(handed?.decision, undefined);
      assert.match(shown(handed), /1 waived · after 1 send-back$/m);
      assert.match(shown(handed), /^\u26A0\uFE0E a .*\n {2}\* kept as you asked$/m);
    });

    test("takes a waiver given before any send-back", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      assert.equal((await agent.stop(repo, false, waive("a", "kept as you asked")))?.decision, undefined);
    });

    test("sends the agent back for another red gate, reminding it of its waiver, which holds while unchanged", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      writeFileSync(join(repo, "b.bad"), "x");
      await agent.stop(repo);
      const again = await agent.stop(repo, true, waive("a", "kept as you asked"));
      assert.equal(again?.decision, "block");
      assert.match(again?.reason ?? "", /Waived this turn, not to fix: a\./);
      assert.match(again?.reason ?? "", /^## b$/m);
      assert.doesNotMatch(again?.reason ?? "", /^## a$/m);
      rmSync(join(repo, "b.bad"));
      const handed = await agent.stop(repo, true);
      assert.equal(handed?.decision, undefined);
      assert.match(shown(handed), /\* kept as you asked/);
    });

    test("lets a waiver fall when the report of its gate changes, so the agent judges it again", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "one");
      await agent.stop(repo);
      writeFileSync(join(repo, "a.bad"), "two");
      const again = await agent.stop(repo, true, waive("a", "kept as you asked"));
      assert.equal(again?.decision, "block");
      assert.match(again?.reason ?? "", /Your waiver of a no longer holds: its report changed\./);
    });

    test("tells the agent when a waive line names no gate of the turn", async () => {
      const repo = await turn();
      writeFileSync(join(repo, "a.bad"), "x");
      await agent.stop(repo);
      const again = await agent.stop(repo, true, waive("aa", "typo"));
      assert.equal(again?.decision, "block");
      assert.match(again?.reason ?? "", /No gate is named aa\. The gates of this turn: a, b\./);
    });

    test("stops sending the agent back at the cap of the repo, and says so", async () => {
      const repo = await turn({ maxSendBacks: 2 });
      writeFileSync(join(repo, "a.bad"), "x");
      assert.equal((await agent.stop(repo))?.decision, "block");
      assert.equal((await agent.stop(repo, true))?.decision, "block");
      const capped = await agent.stop(repo, true);
      assert.equal(capped?.decision, undefined);
      assert.match(shown(capped), /stopped after 2 send-backs$/m);
    });

    test("never sends the agent back when the repo turns send-backs off", async () => {
      const repo = await turn({ maxSendBacks: 0 });
      writeFileSync(join(repo, "a.bad"), "x");
      const stopped = await agent.stop(repo);
      assert.equal(stopped?.decision, undefined);
      assert.match(shown(stopped), /send-backs are off$/m);
    });

    test("counts the send-backs of each turn from zero", async () => {
      const repo = await turn({ maxSendBacks: 1 });
      writeFileSync(join(repo, "a.bad"), "x");
      assert.equal((await agent.stop(repo))?.decision, "block");
      await agent.prompt(repo);
      writeFileSync(join(repo, "b.bad"), "x");
      assert.equal((await agent.stop(repo))?.decision, "block");
    });
  });

  test("tells the owner at the prompt that resumes an interrupted turn, when its gates cannot run any more", async () => {
    const interrupted = agent.repo();
    await agent.prompt(interrupted);
    writeFileSync(join(interrupted, ".gates.json"), "{");
    assert.match((await agent.prompt(interrupted))?.systemMessage ?? "", /could not run/);
  });
});

// A gate that keeps a watch: each test has a session of its own, so the tests run side by side.
type Agent = ReturnType<typeof session>;

// A watch of the .ts files of its folder: each change opens a cycle that prints a FAIL line per file holding
// "broken", and a build failure with its errors after it for a file holding "syntax". It exits on a file holding
// "crash", and goes when its repo does. Given a file, it writes there when it starts and when it is stopped. Given a
// number of milliseconds after it, it looks for changes that seldom, as a watch slowed by a busy machine.
const WATCH = [
  'import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";',
  'if (process.argv[2]) appendFileSync(process.argv[2], "started\\n");',
  'process.on("SIGTERM", () => {',
  '  if (process.argv[2]) appendFileSync(process.argv[2], "stopped\\n");',
  "  process.exit(0);",
  "});",
  'const sources = () => readdirSync(".").filter((file) => file.endsWith(".ts")).sort();',
  'const state = () => sources().map((file) => `${file}:${statSync(file).mtimeMs}`).join("|");',
  "const cycle = () => {",
  '  const texts = sources().map((file) => [file, readFileSync(file, "utf8")]);',
  '  const syntax = texts.filter(([, text]) => text.includes("syntax"));',
  "  if (syntax.length) {",
  '    console.log("build failed");',
  "    for (const [file] of syntax) console.log(`error: ${file}`);",
  "    return;",
  "  }",
  "  for (const [file, text] of texts)",
  '    if (text.includes("crash")) {',
  "      console.log(`crashing on ${file}`);",
  "      process.exit(1);",
  "    }",
  '  for (const [file, text] of texts) if (text.includes("broken")) console.log(`FAIL ${file}`);',
  '  console.log("done");',
  "};",
  "let seen = state();",
  "cycle();",
  "setInterval(() => {",
  '  if (!existsSync(".git")) process.exit(0);',
  "  const now = state();",
  "  if (now === seen) return;",
  "  seen = now;",
  '  console.log("rebuilding");',
  "  setTimeout(cycle, 100);",
  "}, Number(process.argv[3] ?? 300));",
].join("\n");

const gate = (watchRun: string[] = ["watch.mjs"], watch: object = {}) => ({
  name: "tests",
  severity: "error",
  files: "\\.ts$",
  run: ["fail.mjs"],
  watch: {
    run: watchRun,
    cycleStart: "^rebuilding$",
    cycleEnd: "^done$|^build failed$",
    failed: "^FAIL |^build failed$",
    ...watch,
  },
});

function watched(agent: Agent, entry: object = gate()): string {
  const repo = agent.repo(JSON.stringify({ gates: [entry] }));
  writeFileSync(join(repo, "watch.mjs"), WATCH);
  return repo;
}

// The agent sent back by the watch gate, with the failure of the file in the last cycle.
function assertSentBackFor(stopped: HookOutput | undefined, file: string): void {
  assert.equal(stopped?.decision, "block");
  assert.match(stopped?.reason ?? "", new RegExp(`^## tests\\nFAIL ${file.replace(".", "\\.")}$`, "m"));
}

// Runs with the idle delay of the watches shortened to the given milliseconds.
async function idleAfter(ms: number, run: () => Promise<void>): Promise<void> {
  process.env.GATES_WATCH_IDLE_MS = String(ms);
  try {
    await run();
  } finally {
    delete process.env.GATES_WATCH_IDLE_MS;
  }
}

// A repo whose session started 1.2 s ago, with a watch that writes its life in events.log.
async function startedAWhileAgo(agent: Agent): Promise<string> {
  const repo = watched(agent, gate(["watch.mjs", "events.log"]));
  await agent.start(repo, "startup");
  await new Promise((resolve) => setTimeout(resolve, 1200));
  return repo;
}

// A compared watch: no failed pattern, it fails on the lines its last cycle added to the one the turn started on.
const compared = () => ({ ...gate(undefined, { failed: undefined }), compare: "turn-start" });

// What the watch of the repo wrote of its life, once it wrote that many lines, and a while after for any other.
async function events(repo: string, lines: number): Promise<string[]> {
  const file = join(repo, "events.log");
  const read = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
  for (let waited = 0; waited < 3000 && read().length < lines; waited += 50)
    await new Promise((resolve) => setTimeout(resolve, 50));
  await new Promise((resolve) => setTimeout(resolve, 500));
  return read();
}

function watchTest(name: string, run: (agent: Agent) => Promise<void>): void {
  test(name, async () => {
    const agent = session();
    try {
      await run(agent);
    } finally {
      agent.cleanup();
    }
  });
}

describe("a gate that keeps a watch", { concurrency: true }, () => {
  watchTest(
    "sends the agent back with the failing lines of the last cycle of the watch the prompt started",
    async (agent) => {
      const repo = watched(agent);
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "broken");
      const stopped = await agent.stop(repo);
      assertSentBackFor(stopped, "a.ts");
    },
  );

  watchTest("starts the watch at the stop when no hook started it, and judges the turn on it", async (agent) => {
    const repo = watched(agent);
    writeFileSync(join(repo, "a.ts"), "broken");
    const stopped = await agent.stop(repo);
    assertSentBackFor(stopped, "a.ts");
  });

  watchTest("passes a turn that fixes the failure, judged on the last cycle alone", async (agent) => {
    const repo = watched(agent);
    await agent.prompt(repo);
    writeFileSync(join(repo, "a.ts"), "broken");
    await agent.stop(repo);
    await agent.prompt(repo);
    writeFileSync(join(repo, "a.ts"), "fixed");
    const stopped = await agent.stop(repo);
    assert.equal(stopped?.decision, undefined);
    assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), /1\/1 gates green/);
  });

  watchTest("sends the agent back with only the lines a compared watch added since the turn started", async (agent) => {
    const repo = watched(agent, compared());
    writeFileSync(join(repo, "old.ts"), "broken");
    await agent.prompt(repo);
    writeFileSync(join(repo, "a.ts"), "broken");
    const stopped = await agent.stop(repo);
    assertSentBackFor(stopped, "a.ts");
    assert.doesNotMatch(stopped?.reason ?? "", /old\.ts/);
  });

  watchTest("passes a turn whose compared watch prints only the failures the turn started with", async (agent) => {
    const repo = watched(agent, compared());
    writeFileSync(join(repo, "old.ts"), "broken");
    await agent.prompt(repo);
    writeFileSync(join(repo, "a.ts"), "fine");
    const stopped = await agent.stop(repo);
    assert.equal(stopped?.decision, undefined);
    const shown = stripVTControlCharacters(stopped?.systemMessage ?? "");
    assert.match(shown, /1\/1 gates green/);
    assert.doesNotMatch(shown, /not compared/);
  });

  watchTest("says a compared watch with no report from the turn start judged nothing", async (agent) => {
    const repo = watched(agent, compared());
    writeFileSync(join(repo, "a.ts"), "broken");
    const stopped = await agent.stop(repo);
    assert.equal(stopped?.decision, undefined);
    assert.match(
      stripVTControlCharacters(stopped?.systemMessage ?? ""),
      /tests not judged: no report from the turn start to compare its cycle with/,
    );
  });

  watchTest(
    "sends the agent back with the lines a failed build prints after the line that ends its cycle",
    async (agent) => {
      const repo = watched(agent);
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "syntax");
      const stopped = await agent.stop(repo);
      assert.equal(stopped?.decision, "block");
      assert.match(stopped?.reason ?? "", /^build failed\nerror: a\.ts$/m);
    },
  );

  watchTest("skips the gate without waiting on the watch when the turn changes no file it looks at", async (agent) => {
    const repo = watched(agent);
    await agent.prompt(repo);
    writeFileSync(join(repo, "notes.md"), "words");
    const started = performance.now();
    const stopped = await agent.stop(repo);
    assert.ok(performance.now() - started < 1000);
    assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), /no gate looks at the 1 changed file/);
  });

  watchTest("leaves out a gate whose watch is wrong, says why, and still runs the others", async (agent) => {
    for (const [entry, why] of [
      [gate(["watch.mjs", "{files}"]), /tests not run, its entry is wrong: a watch outlives the turn/],
      [gate(["watch.mjs", "--since={turn}"]), /tests not run, its entry is wrong: a watch outlives the turn/],
      [gate(undefined, { failed: "(" }), /tests not run, its entry is wrong: watch\.failed is a regular expression/],
      [gate(undefined, { cycleEnd: undefined }), /watch\.cycleEnd is a regular expression/],
      [gate(undefined, { debounce: 1 }), /unknown field watch\.debounce/],
      [{ ...gate(), compare: "turn-start" }, /a compared watch fails on the lines its cycle added: no watch\.failed/],
    ] as const) {
      const repo = agent.repo(
        JSON.stringify({ gates: [entry, { name: "fail", severity: "error", files: "\\.ts$", run: ["false"] }] }),
      );
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "broken");
      const stopped = await agent.stop(repo);
      assert.match(stopped?.reason ?? "", /^## fail$/m);
      assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), why);
    }
  });

  watchTest(
    "judges the turn on the first cycle that starts after its change, however long the watch takes to see it",
    async (agent) => {
      const repo = watched(agent, gate(["watch.mjs", "", "3000"]));
      await agent.prompt(repo);
      // Changed once the watch has read the files: it sees the change about 2 s later, past the quiet window.
      await new Promise((resolve) => setTimeout(resolve, 1000));
      writeFileSync(join(repo, "a.ts"), "broken");
      const started = performance.now();
      assertSentBackFor(await agent.stop(repo), "a.ts");
      // Judged as soon as that cycle ends, not once the engine gives up on the watch seeing the change.
      assert.ok(performance.now() - started < 4500);
    },
  );

  watchTest("judges a change the watch never reacts to once the quiet window has passed", async (agent) => {
    const repo = watched(agent);
    await agent.prompt(repo);
    // The fake watch only reads the .ts files at the root, as a build never reaches a file no test imports.
    mkdirSync(join(repo, "unused"));
    writeFileSync(join(repo, "unused", "b.ts"), "broken");
    const started = performance.now();
    const stopped = await agent.stop(repo);
    // No cycle starts, so the stop waits the 5 s the engine gives a watch to see a change, and no longer.
    assert.ok(performance.now() - started < 7000);
    assert.equal(stopped?.decision, undefined);
    assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), /1\/1 gates green/);
  });

  watchTest(
    "sends the agent back with the last lines of a watch that exited, and starts it again at the next prompt",
    async (agent) => {
      const repo = watched(agent);
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "crash");
      const stopped = await agent.stop(repo);
      assert.equal(stopped?.decision, "block");
      assert.match(stopped?.reason ?? "", /^## tests\nThe watch stopped\. Its last lines:\n(.+\n)*crashing on a\.ts$/m);
      writeFileSync(join(repo, "a.ts"), "fixed");
      await agent.prompt(repo);
      writeFileSync(join(repo, "b.ts"), "broken");
      assert.match((await agent.stop(repo))?.reason ?? "", /^## tests\nFAIL b\.ts$/m);
    },
  );

  watchTest("starts the watch as soon as the session starts", async (agent) => {
    const repo = watched(agent, gate(["watch.mjs", "events.log"]));
    assert.equal(await agent.start(repo, "startup"), undefined);
    assert.deepEqual(await events(repo, 1), ["started"]);
  });

  watchTest("shares one watch between two sessions of the same repo", async (agent) => {
    const repo = watched(agent, gate(["watch.mjs", "events.log"]));
    const other = session();
    try {
      await agent.start(repo, "startup");
      await agent.prompt(repo);
      await other.start(repo, "startup");
      await other.prompt(repo);
      assert.deepEqual(await events(repo, 1), ["started"]);
    } finally {
      other.cleanup();
    }
  });

  watchTest(
    "stops the watch when the last session of its repo ends, and keeps it while another one uses it",
    async (agent) => {
      const repo = watched(agent, gate(["watch.mjs", "events.log"]));
      const other = session();
      try {
        await agent.start(repo, "startup");
        await other.prompt(repo);
        assert.equal(await agent.end(repo), undefined);
        assert.deepEqual(await events(repo, 2), ["started"]);
        await other.end(repo);
        assert.deepEqual(await events(repo, 2), ["started", "stopped"]);
      } finally {
        other.cleanup();
      }
    },
  );

  watchTest("asks to install a watch program this machine does not have, and leaves the gate off", async (agent) => {
    const repo = watched(agent, gate(["no-such-watcher"]));
    const asked = await agent.prompt(repo);
    assert.match(asked?.hookSpecificOutput?.additionalContext ?? "", /- tests: no-such-watcher is not installed/);
    writeFileSync(join(repo, "a.ts"), "broken");
    const stopped = await agent.stop(repo);
    assert.equal(stopped?.decision, undefined);
    assert.match(
      stripVTControlCharacters(stopped?.systemMessage ?? ""),
      /tests not run: no-such-watcher is not installed/,
    );
  });

  watchTest("starts one watch when two sessions start at the same instant, each in its own process", async (agent) => {
    const repo = watched(agent, gate(["watch.mjs", "events.log"]));
    const sessions = [`test-${randomUUID()}`, `test-${randomUUID()}`];
    const hook = (id: string) =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, [CLI, "hook", "session-start"], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("exit", resolve);
        child.stdin.end(
          JSON.stringify({ session_id: id, cwd: repo, hook_event_name: "SessionStart", source: "startup" }),
        );
      });
    const end = (id: string) => handleHook("session-end", JSON.stringify({ session_id: id, cwd: repo }));
    try {
      await Promise.all(sessions.map(hook));
      assert.deepEqual(await events(repo, 2), ["started"]);
    } finally {
      for (const id of sessions) await end(id);
    }
  });

  watchTest(
    "keeps every session of a watch that starts again, and stops it only when the last of them ends",
    async (agent) => {
      const repo = watched(agent, gate(["watch.mjs", "events.log"]));
      const other = session();
      try {
        await agent.prompt(repo);
        await other.prompt(repo);
        writeFileSync(join(repo, "a.ts"), "crash");
        await agent.stop(repo);
        writeFileSync(join(repo, "a.ts"), "fixed");
        await agent.prompt(repo);
        assert.deepEqual(await events(repo, 2), ["started", "started"]);
        await agent.end(repo);
        assert.deepEqual(await events(repo, 3), ["started", "started"]);
        await other.end(repo);
        assert.deepEqual(await events(repo, 3), ["started", "started", "stopped"]);
      } finally {
        other.cleanup();
      }
    },
  );

  watchTest(
    "shows out of time, without sending the agent back, a watch whose cycle is still open when time runs out",
    async (agent) => {
      const repo = watched(agent, { ...gate(undefined, { cycleEnd: "^never$" }), timeoutSeconds: 2 });
      await agent.prompt(repo);
      writeFileSync(join(repo, "a.ts"), "broken");
      const stopped = await agent.stop(repo);
      assert.equal(stopped?.decision, undefined);
      assert.match(stripVTControlCharacters(stopped?.systemMessage ?? ""), /0\/1 gates green in .* · 1 out of time/);
    },
  );
});

// The idle delay is shortened through the environment, which every watch started meanwhile reads: one at a time.
describe("a gate that keeps a watch, with a short idle delay", () => {
  watchTest(
    "stops the watch once its repo has had no prompt nor stop for the idle delay, and starts it at the next prompt",
    async (agent) => {
      await idleAfter(2000, async () => {
        const repo = await startedAWhileAgo(agent);
        await agent.prompt(repo);
        await new Promise((resolve) => setTimeout(resolve, 800));
        // Longer than the delay since the session started, shorter since the prompt.
        assert.deepEqual(await events(repo, 1), ["started"]);
        assert.deepEqual(await events(repo, 2), ["started", "stopped"]);
        await agent.prompt(repo);
        assert.deepEqual(await events(repo, 3), ["started", "stopped", "started"]);
      });
    },
  );

  watchTest(
    "counts a stop that skips the gate as activity, which keeps the watch from stopping for idleness",
    async (agent) => {
      await idleAfter(2000, async () => {
        const repo = await startedAWhileAgo(agent);
        writeFileSync(join(repo, "notes.md"), "words");
        await agent.stop(repo);
        await new Promise((resolve) => setTimeout(resolve, 800));
        // Longer than the delay since the session started, shorter since the stop.
        assert.deepEqual(await events(repo, 1), ["started"]);
      });
    },
  );

  watchTest(
    "starts again at the stop a watch stopped for idleness during a long turn, and judges the turn on it",
    async (agent) => {
      await idleAfter(1000, async () => {
        const repo = watched(agent, gate(["watch.mjs", "events.log"]));
        await agent.prompt(repo);
        assert.deepEqual(await events(repo, 2), ["started", "stopped"]);
        writeFileSync(join(repo, "a.ts"), "broken");
        assertSentBackFor(await agent.stop(repo), "a.ts");
      });
    },
  );
});
