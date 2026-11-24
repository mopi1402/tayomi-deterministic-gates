import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkAll, checkTurn, startTurn } from "./check.ts";
import { gatesOf, readGatesFiles } from "./config.ts";
import { cachedReports } from "./report-cache.ts";
import { snapshot } from "./snapshot.ts";
import { readTurn, writeTurn } from "./turn-state.ts";
import { commitAll, git, tempRepo, writeGates } from "../testing.ts";

let repo = "";
let session = "";

const gates = (...list: object[]) => writeGates(repo, ...list);

function cachedNow(): string | undefined {
  const [gate] = gatesOf(readGatesFiles(repo)).gates;
  return gate && cachedReports(repo, snapshot(repo).tree)(gate);
}

beforeEach(() => {
  repo = tempRepo();
  session = `test-${randomUUID()}`;
  gates();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a turn the owner interrupts", () => {
  test("is checked with the next turn: the next one starts where it did", async () => {
    await startTurn(session, repo);
    const interrupted = readTurn(session, repo)?.start;
    writeFileSync(join(repo, "written-before-the-interruption.ts"), "1");
    await startTurn(session, repo);
    assert.equal(readTurn(session, repo)?.start, interrupted);
  });

  test("never holds back a turn once a check covered it", async () => {
    await startTurn(session, repo);
    const checked = readTurn(session, repo)?.start;
    writeFileSync(join(repo, "checked.ts"), "1");
    await checkTurn(session, repo);
    await startTurn(session, repo);
    assert.notEqual(readTurn(session, repo)?.start, checked);
    assert.equal(readTurn(session, repo)?.checked, false);
  });
});

describe("a check with no recorded start", () => {
  test("still checks, from the last commit, and says so", async () => {
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /no turn start recorded/);
    assert.equal(readTurn(session, repo)?.checked, true);
  });

  test("says which compared gates had no report to compare with, instead of a silent green", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("old problem")');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /dead not compared: no report from the turn start/);
  });
});

describe("the gates a turn is checked with", () => {
  const failing = { name: "fail", severity: "error", files: "\\.ts$", run: ["fail.mjs"] };

  test("are the ones it started with, even when the turn weakens .gates.json, and the check says so", async () => {
    writeFileSync(join(repo, "fail.mjs"), "process.exit(1)");
    gates(failing);
    await startTurn(session, repo);
    gates();
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.equal(turn.outcomes.find(({ name }) => name === "fail")?.ok, false);
    assert.match(turn.note ?? "", /the turn changed \.gates\.json: checked with the gates as the turn started/);
  });

  test("are the ones it started with, even when the turn turns one off in an ignored .gates.local.json", async () => {
    writeFileSync(join(repo, "fail.mjs"), "process.exit(1)");
    writeFileSync(join(repo, ".gitignore"), ".gates.local.json\n");
    gates(failing);
    await startTurn(session, repo);
    writeFileSync(join(repo, ".gates.local.json"), JSON.stringify({ gates: [{ name: "fail", severity: "off" }] }));
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.equal(turn.outcomes.find(({ name }) => name === "fail")?.ok, false);
    assert.match(turn.note ?? "", /the turn changed \.gates\.local\.json/);
  });
});

describe("a check whose recorded start git no longer has", () => {
  test("checks from the last commit and says so, so the next turns are not held on it", async () => {
    writeTurn(session, repo, {
      start: "0123456789abcdef0123456789abcdef01234567",
      baselines: {},
      config: {},
      checked: false,
    });
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /turn start lost/);
    assert.equal(readTurn(session, repo)?.checked, true);
  });
});

describe("a check of the whole repo", () => {
  test("runs each gate on every file of the repo, committed or not, whatever the turn changed", async () => {
    writeFileSync(join(repo, "tool.mjs"), "console.log(process.argv.slice(2).join(' ')); process.exit(1)");
    gates({ name: "list", severity: "error", files: "\\.ts$", run: ["tool.mjs", "{files}"] });
    writeFileSync(join(repo, "committed.ts"), "1");
    commitAll(repo, "old");
    await startTurn(session, repo);
    writeFileSync(join(repo, "new.ts"), "1");
    const all = await checkAll(repo);
    assert.equal(all.outcomes.find(({ name }) => name === "list")?.output, "committed.ts new.ts");
  });

  test("counts every line of a compared gate, not only the ones a turn added", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("old problem")');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    writeFileSync(join(repo, "a.ts"), "1");
    const all = await checkAll(repo);
    assert.deepEqual(
      all.outcomes.map(({ name, ok, output }) => ({ name, ok, output })),
      [{ name: "dead", ok: false, output: "old problem" }],
    );
  });
});

describe("the reports a check leaves for the next turn", () => {
  const cases = [
    { name: "a turn that changed nothing keeps the start report", run: ["tool.mjs"], changed: "", kept: true },
    { name: "a whole-project run keeps its report", run: ["tool.mjs"], changed: "a.ts", kept: true },
    { name: "a gate that did not run keeps none", run: ["tool.mjs"], changed: "tsconfig.json", kept: false },
  ];
  for (const { name, run, changed, kept } of cases) {
    test(name, async () => {
      writeFileSync(join(repo, "tool.mjs"), 'console.log("fine")');
      gates({ name: "dead", severity: "error", files: "\\.ts$", run, compare: "turn-start" });
      await startTurn(session, repo);
      if (changed) writeFileSync(join(repo, changed), "{}");
      await checkTurn(session, repo);
      assert.equal(cachedNow(), kept ? "fine" : undefined);
    });
  }
});

describe("a prompt whose hook is stopped before the reports of its turn start are ready", () => {
  test("has already started its turn: the send-backs of the turn before are gone", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'setTimeout(() => console.log("old"), 300)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    await checkTurn(session, repo);
    const checked = readTurn(session, repo);
    assert.ok(checked);
    writeTurn(session, repo, { ...checked, sendBacks: { count: 2, waivers: {}, reports: {} } });
    writeFileSync(join(repo, "a.ts"), "1");
    const starting = startTurn(session, repo);
    const started = readTurn(session, repo);
    assert.equal(started?.checked, false);
    assert.equal(started?.sendBacks, undefined);
    await starting;
  });
});

describe("a report out of time as the turn started", () => {
  test("is no report: the turn says it has none to compare with, where its lines would all be new", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'setTimeout(() => console.log("old"), 3000)');
    gates({
      name: "dead",
      severity: "error",
      files: "\\.ts$",
      run: ["tool.mjs"],
      compare: "turn-start",
      timeoutSeconds: 1,
    });
    await startTurn(session, repo);
    assert.deepEqual(readTurn(session, repo)?.baselines, {});
  });
});

describe("a report that broke as the turn started", () => {
  test("serves that turn, but is never kept for the next one", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    assert.deepEqual(readTurn(session, repo)?.baselines, { dead: "boom" });
    assert.equal(cachedNow(), undefined);
  });
});

describe("a report that broke as the turn started, after a turn that changed nothing", () => {
  test("is still not kept: the next turn runs the command again", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    await checkTurn(session, repo);
    assert.equal(cachedNow(), undefined);
  });
});

describe("a compared gate whose command breaks", () => {
  test("fails every turn it breaks in, whether it broke as the turn started or since: neither is excused", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    for (const file of ["a.ts", "b.ts"]) {
      await startTurn(session, repo);
      writeFileSync(join(repo, file), "1");
      const [outcome] = (await checkTurn(session, repo)).outcomes;
      assert.deepEqual([outcome?.ok, outcome?.broken, outcome?.timedOut], [false, true, undefined], file);
    }
  });
});

describe("a compared gate the agent leaves failing", () => {
  test("fails the next turn too: what a turn added stays new until it is fixed", async () => {
    writeFileSync(
      join(repo, "tool.mjs"),
      'import { existsSync } from "node:fs"; console.log("fine"); if (existsSync("a.ts")) console.log("unused a");',
    );
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    assert.equal((await checkTurn(session, repo)).outcomes[0]?.output, "unused a");
    await startTurn(session, repo);
    writeFileSync(join(repo, "b.ts"), "1");
    assert.equal((await checkTurn(session, repo)).outcomes[0]?.output, "unused a");
  });
});

describe("a file the turn deleted", () => {
  const print = 'console.log(process.argv.slice(2).join(" ") || "no file")';
  const whole = { name: "whole", severity: "error", files: "\\.ts$", run: ["tool.mjs"] };
  const named = { name: "named", severity: "error", files: "\\.ts$", run: ["tool.mjs", "{files}"] };

  test("runs the gates that look at it, and is never named in {files}", async () => {
    writeFileSync(join(repo, "tool.mjs"), print);
    writeFileSync(join(repo, "a.ts"), "1");
    writeFileSync(join(repo, "b.ts"), "1");
    gates(whole, named);
    await startTurn(session, repo);
    rmSync(join(repo, "a.ts"));
    writeFileSync(join(repo, "b.ts"), "2");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(turn.changed, ["a.ts", "b.ts"]);
    assert.deepEqual(
      turn.outcomes.map(({ name, output }) => [name, output]),
      [
        ["whole", "no file"],
        ["named", "b.ts"],
      ],
    );
  });

  test("skips a gate that would have nothing but deleted files to look at", async () => {
    writeFileSync(join(repo, "tool.mjs"), print);
    writeFileSync(join(repo, "a.ts"), "1");
    gates(whole, named);
    await startTurn(session, repo);
    rmSync(join(repo, "a.ts"));
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name }) => name),
      ["whole"],
    );
    assert.deepEqual(turn.skipped, ["named"]);
  });
});

describe("a gate whose tool this machine does not have", () => {
  const missing = { name: "lint", severity: "error", files: "\\.ts$", run: ["no-such-tool", "{files}"] };
  const present = { name: "true", severity: "error", files: "\\.ts$", run: ["true"] };

  test("is named as the turn starts, with why", async () => {
    gates(missing, present);
    assert.deepEqual(await startTurn(session, repo), [
      "lint: no-such-tool is not installed: it is neither a package of node_modules nor a program on the PATH.",
    ]);
  });

  test("never runs nor fails the turn, and the check names it when the turn concerned it", async () => {
    gates(missing, present);
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name, ok }) => [name, ok]),
      [["true", true]],
    );
    assert.match(turn.note ?? "", /^lint not run: no-such-tool is not installed/m);
  });

  test("is not named when the turn did not concern it", async () => {
    gates(missing, present);
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.md"), "1");
    assert.equal((await checkTurn(session, repo)).note, undefined);
  });
});

describe("a gate with a problem of its own", () => {
  test("is left out and named, while the other gates of the file still run", async () => {
    gates(
      { name: "broken", severity: "error", files: "\\.ts$", run: ["true"], extra: 1 },
      { name: "fine", severity: "error", files: "\\.ts$", run: ["true"] },
    );
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name }) => name),
      ["fine"],
    );
    assert.match(turn.note ?? "", /^broken not run, its entry is wrong: unknown field extra$/m);
  });
});

describe("a turn that moves HEAD to code it did not write", () => {
  const as = ["-c", "user.name=test", "-c", "user.email=test@test.invalid"];
  const judged = async () => {
    const turn = await checkTurn(session, repo);
    return { ...turn, said: Object.fromEntries(turn.outcomes.map(({ name, output }) => [name, output])) };
  };

  // On main, a.ts. On feature, b.ts and c.ts more. The lint gate names the files it is given, and fails.
  beforeEach(() => {
    writeFileSync(join(repo, "lint.mjs"), 'console.log(process.argv.slice(2).join(" ")); process.exit(1)');
    gates({ name: "lint", severity: "error", files: "\\.ts$", run: ["lint.mjs", "{files}"] });
    writeFileSync(join(repo, "a.ts"), "a");
    commitAll(repo, "main");
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(repo, "b.ts"), "b");
    writeFileSync(join(repo, "c.ts"), "c");
    commitAll(repo, "feature");
    git(repo, ["checkout", "--quiet", "main"]);
  });

  test("judges nothing after a checkout alone, and says HEAD moved", async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    const turn = await judged();
    assert.deepEqual([turn.changed, turn.outcomes], [[], []]);
    assert.match(turn.note ?? "", /HEAD moved during the turn \(checkout: moving from main to feature\)/);
  });

  test("judges only the file the turn wrote after a checkout", async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "d.ts"), "d");
    writeFileSync(join(repo, "b.ts"), "b, edited");
    assert.equal((await judged()).said.lint, "b.ts d.ts");
  });

  test("judges a file the turn wrote before a checkout that kept it", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    git(repo, ["checkout", "--quiet", "feature"]);
    assert.equal((await judged()).said.lint, "d.ts");
  });

  test("judges what the agent commits on its branch as before, without a note", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    const turn = await judged();
    assert.equal(turn.said.lint, "d.ts");
    assert.equal(turn.note, undefined);
  });

  test("judges nothing a merge brought, as a pull does", async () => {
    await startTurn(session, repo);
    git(repo, [...as, "merge", "--quiet", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("judges nothing a reset to another commit brought", async () => {
    await startTurn(session, repo);
    git(repo, ["reset", "--quiet", "--hard", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("still judges what the turn committed before a rebase, and nothing the rebase brought", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    git(repo, [...as, "rebase", "--quiet", "feature"]);
    assert.equal((await judged()).said.lint, "d.ts");
  });

  test("judges the file of a conflict the turn resolved in a merge, and no other file the merge brought", async () => {
    writeFileSync(join(repo, "a.ts"), "a, on main");
    commitAll(repo, "main again");
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "a.ts"), "a, on feature");
    commitAll(repo, "feature again");
    git(repo, ["checkout", "--quiet", "main"]);
    await startTurn(session, repo);
    assert.throws(() => git(repo, [...as, "merge", "--quiet", "feature"]));
    writeFileSync(join(repo, "a.ts"), "a, resolved");
    commitAll(repo, "merge");
    assert.equal((await judged()).said.lint, "a.ts");
  });

  test("gives a gate the commit HEAD moved to as the turn start", async () => {
    writeFileSync(join(repo, "start.mjs"), "console.log(process.argv[2]); process.exit(1)");
    gates({ name: "start", severity: "error", files: "\\.ts$", run: ["start.mjs", "{turn}"] });
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "d.ts"), "d");
    assert.equal((await judged()).said.start, git(repo, ["rev-parse", "feature"]));
  });

  describe("with a compared gate", () => {
    const tool =
      'import { readdirSync } from "node:fs"; for (const file of readdirSync(".")) if (file.endsWith(".ts")) console.log(`${file}: unused`)';
    const dead = { name: "dead", severity: "error", files: "\\.ts$", run: ["dead.mjs"], compare: "turn-start" };

    test("counts only the lines that name a file of the turn", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates({ ...dead, lineKey: "^(?<file>[^:]+)" });
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      writeFileSync(join(repo, "d.ts"), "d");
      assert.equal((await judged()).said.dead, "d.ts: unused");
    });

    test("does not compare one whose lines name no file, and says so", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      writeFileSync(join(repo, "d.ts"), "d");
      const turn = await judged();
      assert.equal(turn.outcomes[0]?.ok, true);
      assert.match(turn.note ?? "", /dead not compared: its report of the turn start is of the code HEAD left/);
    });

    test("leaves the next turn a report of the code HEAD moved to", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      await checkTurn(session, repo);
      await startTurn(session, repo);
      writeFileSync(join(repo, "a.ts"), "a, edited");
      assert.equal((await judged()).outcomes[0]?.ok, true);
    });
  });
});
