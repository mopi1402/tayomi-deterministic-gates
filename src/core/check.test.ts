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
import { commitAll, tempRepo, writeGates } from "../testing.ts";

let repo = "";
let session = "";

const gates = (...list: object[]) => writeGates(repo, ...list);

function cachedNow(): string | undefined {
  const [gate] = gatesOf(readGatesFiles(repo));
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
