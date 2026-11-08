import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { git, outcome, ran, tempRepo } from "../testing.ts";
import { handleHook, parseHookInput, stopOutput } from "./hook.ts";

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
    stop: (cwd: string, retry = false) =>
      handleHook("check", event("Stop", cwd, { stop_hook_active: retry, last_assistant_message: "" })),
    cleanup: () => {
      for (const path of folders) rmSync(path, { recursive: true, force: true });
    },
  };
}

describe("parseHookInput", () => {
  test("keeps the fields it knows, with their types, and nothing from text it cannot read", () => {
    assert.deepEqual(parseHookInput('{"session_id":"s","stop_hook_active":true,"cwd":"/r","other":1}'), {
      session_id: "s",
      stop_hook_active: true,
      cwd: "/r",
    });
    assert.deepEqual(parseHookInput('{"session_id":3}'), {});
    assert.deepEqual(parseHookInput("not json"), {});
  });
});

describe("stopOutput", () => {
  test("only shows the summary when every gate passes", () => {
    const output = stopOutput(ran([outcome("lint", true)]), false);
    assert.equal(output.decision, undefined);
    assert.ok(output.systemMessage);
  });

  test("sends the agent back once with the reports of the failed gates", () => {
    const output = stopOutput(ran([outcome("lint", false), outcome("dead", true)]), false);
    assert.equal(output.decision, "block");
    assert.match(output.reason ?? "", /## lint\nlint report/);
  });

  test("never sends the agent back for a gate out of time, and shows it apart from the green and the red", () => {
    const late = { ...outcome("tests", false), timedOut: true };
    const output = stopOutput(ran([outcome("lint", true), late]), false);
    assert.equal(output.decision, undefined);
    assert.match(stripVTControlCharacters(output.systemMessage), /1\/2 gates green in .* · 1 out of time/);
    assert.match(stripVTControlCharacters(output.systemMessage), /⏱ tests/);
    const both = stopOutput(ran([outcome("lint", false), late]), false);
    assert.equal(both.decision, "block");
    assert.doesNotMatch(both.reason ?? "", /## tests/);
  });

  test("never sends the agent back twice, so it never loops", () => {
    const output = stopOutput(ran([outcome("lint", false)]), true);
    assert.equal(output.decision, undefined);
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
    assert.match((await agent.stop(elsewhere, true))?.systemMessage ?? "", /handed back anyway/);
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

  test("tells the owner at the prompt that resumes an interrupted turn, when its gates cannot run any more", async () => {
    const interrupted = agent.repo();
    await agent.prompt(interrupted);
    writeFileSync(join(interrupted, ".gates.json"), "{");
    assert.match((await agent.prompt(interrupted))?.systemMessage ?? "", /could not run/);
  });
});
