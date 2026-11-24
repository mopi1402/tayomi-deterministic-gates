import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { USAGE } from "./cli.ts";
import { tempRepo, writeGates } from "./testing.ts";

const CLI = join(import.meta.dirname, "cli.ts");

let repo = "";

function cli(args: string[], { input = "", node = [] as string[] } = {}) {
  const options = { cwd: repo, encoding: "utf8" as const, input };
  const { status, stdout, stderr } = spawnSync(process.execPath, [...node, CLI, ...args], options);
  return { status, stdout: stripVTControlCharacters(stdout), stderr };
}

beforeEach(() => {
  repo = tempRepo();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

/** A repo with a gate that fails and one that passes, on its one file. */
function redAndGreen(...more: object[]): void {
  writeFileSync(join(repo, "fail.mjs"), 'console.log("a problem"); process.exit(1)');
  writeFileSync(join(repo, "pass.mjs"), "");
  writeFileSync(join(repo, "a.ts"), "1");
  writeGates(
    repo,
    { name: "red", severity: "error", files: "\\.ts$", run: ["fail.mjs"] },
    { name: "green", severity: "error", files: "\\.ts$", run: ["pass.mjs"] },
    ...more,
  );
}

describe("check", () => {
  test("reports every gate on the whole repo, then each failed report, and exits with 1", () => {
    redAndGreen();
    const { status, stdout } = cli(["check"]);
    assert.equal(status, 1);
    assert.match(stdout, /1\/2 gates green/);
    assert.match(stdout, /## red\na problem/);
    assert.doesNotMatch(stdout, /agent/);
  });

  test("exits with 0 when every gate is green", () => {
    writeFileSync(join(repo, "pass.mjs"), "");
    writeFileSync(join(repo, "a.ts"), "1");
    writeGates(repo, { name: "green", severity: "error", files: "\\.ts$", run: ["pass.mjs"] });
    const { status, stdout } = cli(["check"]);
    assert.equal(status, 0);
    assert.match(stdout, /1\/1 gates green/);
  });

  test("runs the one-shot command of a gate that keeps a watch, and starts no watch", () => {
    writeFileSync(join(repo, "once.mjs"), 'console.log("a problem, once"); process.exit(1)');
    writeFileSync(join(repo, "watch.mjs"), 'import { writeFileSync } from "node:fs"; writeFileSync("watched", "")');
    writeFileSync(join(repo, "a.ts"), "1");
    const watch = {
      run: ["watch.mjs"],
      cycleStart: "^rebuilding$",
      cycleEnd: "^done$",
      failed: "^FAIL ",
      sync: "watch.sync",
    };
    writeGates(repo, { name: "tests", severity: "error", files: "\\.ts$", run: ["once.mjs"], watch });
    const { status, stdout } = cli(["check"]);
    assert.equal(status, 1);
    assert.match(stdout, /## tests\na problem, once/);
    assert.equal(existsSync(join(repo, "watched")), false);
  });

  test("prints the check as JSON for a tool, each gate with its status, and exits the same", () => {
    redAndGreen({ name: "styles", severity: "error", files: "\\.css$", run: ["pass.mjs"] });
    const { status, stdout } = cli(["check", "--format", "json"]);
    assert.equal(status, 1);
    const { ok, gates, notes } = JSON.parse(stdout);
    assert.equal(ok, false);
    assert.deepEqual(notes, []);
    assert.deepEqual(
      gates.map(({ durationMs, ...gate }: { durationMs?: number }) => ({
        ...gate,
        timed: typeof durationMs === "number",
      })),
      [
        { name: "red", status: "failed", report: "a problem", timed: true },
        { name: "green", status: "passed", timed: true },
        { name: "styles", status: "skipped", timed: false },
      ],
    );
  });

  test("prints the usage for a format it does not know, and exits with 2", () => {
    writeGates(repo, { name: "green", severity: "error", files: "\\.ts$", run: ["pass.mjs"] });
    const { status, stdout, stderr } = cli(["check", "--format", "xml"]);
    assert.equal(status, 2);
    assert.equal(stdout, "");
    assert.equal(stderr.trim(), USAGE);
  });

  test("says so outside git, and exits with 2", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const { status, stderr } = cli(["check"]);
    assert.equal(status, 2);
    assert.match(stderr, /not in a git repository/i);
  });

  test("says so in a repo with no gates file, and exits with 2", () => {
    const { status, stderr } = cli(["check"]);
    assert.equal(status, 2);
    assert.match(stderr, /no \.gates\.json/i);
  });

  test("says so when the gates file does not parse, and exits with 2 without a stack trace", () => {
    writeFileSync(join(repo, ".gates.json"), "{");
    const { status, stderr } = cli(["check"]);
    assert.equal(status, 2);
    assert.match(stderr, /\.gates\.json is not valid JSON/);
    assert.doesNotMatch(stderr, /\n\s+at /);
  });
});

describe("words it does not know", () => {
  test("print the usage, and exit with 2", () => {
    const { status, stderr } = cli(["lint"]);
    assert.equal(status, 2);
    assert.equal(stderr.trim(), USAGE);
  });
});

describe("on a Node before 24.2", () => {
  test("tells the owner, in the hook and in check, instead of helpers that never run", () => {
    const old = join(repo, "old-node.cjs");
    writeFileSync(old, 'Object.defineProperty(process.versions, "node", { value: "24.1.0" });');
    writeGates(repo);
    const input = JSON.stringify({ session_id: "s", cwd: repo });
    const hook = cli(["hook", "check"], { input, node: ["--require", old] });
    assert.equal(hook.status, 0);
    assert.match(hook.stdout, /"systemMessage":".*Node 24\.2 or later is needed, this is 24\.1\.0/);
    const check = cli(["check"], { node: ["--require", old] });
    assert.equal(check.status, 2);
    assert.match(check.stderr, /Node 24\.2 or later is needed, this is 24\.1\.0/);
  });
});
