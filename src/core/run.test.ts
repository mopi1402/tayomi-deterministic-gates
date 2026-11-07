import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Gate } from "./config.ts";
import { argumentsOf, type Command, check, commandOf, filesOf, newLines, wholeProject } from "./run.ts";

const LINT: Gate = {
  name: "lint",
  severity: "error",
  files: "\\.tsx?$",
  run: ["eslint", "--max-warnings", "0", "{files}"],
  timeoutSeconds: 60,
};

const COMPARED: Gate = {
  name: "dead",
  severity: "error",
  files: "",
  run: ["tool.mjs"],
  compare: "turn-start",
  timeoutSeconds: 5,
};

let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gates-run-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function tool(code: string) {
  writeFileSync(join(root, "tool.mjs"), code);
}

function pick({ file, args }: Command): string[] {
  return [file, ...args];
}

describe("filesOf", () => {
  test("keeps the changed files the gate looks at", () => {
    assert.deepEqual(filesOf(LINT, ["README.md", "src/a.ts", "src/b.tsx"]), ["src/a.ts", "src/b.tsx"]);
  });
});

describe("argumentsOf", () => {
  test("expands {files} into the files and {turn} into the commit", () => {
    assert.deepEqual(argumentsOf(LINT, ["a.ts", "b.ts"], "abc"), ["--max-warnings", "0", "a.ts", "b.ts"]);
    const clones = { ...LINT, run: ["jscpd", "--baseline-from-ref", "{turn}"] };
    assert.deepEqual(argumentsOf(clones, ["a.ts"], "abc"), ["--baseline-from-ref", "abc"]);
  });
});

describe("commandOf", () => {
  test("runs a script of the engine and a script of the repo on Node", () => {
    const engine = commandOf(root, "{engine}/src/helpers/new-clones.ts");
    assert.equal(engine.file, process.execPath);
    assert.match(engine.args[0] ?? "", /src[/\\]helpers[/\\]new-clones\.ts$/);
    assert.deepEqual(pick(commandOf(root, "scripts/tool.mjs")), [process.execPath, join(root, "scripts/tool.mjs")]);
  });

  test("runs a Python script of the repo on python3", () => {
    assert.deepEqual(pick(commandOf(root, "scripts/check.py")), ["python3", join(root, "scripts/check.py")]);
  });

  test("runs the command of a package of node_modules on Node", () => {
    mkdirSync(join(root, "node_modules", "typescript"), { recursive: true });
    const bin = { tsc: "./bin/tsc", tsserver: "./bin/tsserver" };
    writeFileSync(join(root, "node_modules", "typescript", "package.json"), JSON.stringify({ bin }));
    const tsc = join(root, "node_modules", "typescript", "bin", "tsc");
    assert.deepEqual(pick(commandOf(root, "typescript")), [process.execPath, tsc]);
  });

  test("runs any other name from the PATH, a path from the repo, and an absolute path as it is", () => {
    assert.deepEqual(pick(commandOf(root, "gofmt")), ["gofmt"]);
    assert.deepEqual(pick(commandOf(root, ".venv/bin/ruff")), [join(root, ".venv/bin/ruff")]);
    assert.deepEqual(pick(commandOf(root, "/usr/bin/env")), ["/usr/bin/env"]);
  });
});

describe("newLines", () => {
  test("keeps only the lines the turn added, less the ignored ones", () => {
    const before = "Unused exports (1)\nsrc/a.ts: old";
    const after = "Unused exports (2)\nsrc/a.ts: old\nsrc/b.ts: fresh\n";
    assert.deepEqual(newLines(before, after, "\\(\\d+\\)$"), ["src/b.ts: fresh"]);
  });
});

describe("check, on any language", () => {
  test("runs a Python script of the repo", async () => {
    writeFileSync(join(root, "check.py"), 'import sys\nprint("bad: " + sys.argv[1])\nsys.exit(1)\n');
    const python = { ...LINT, run: ["check.py", "{files}"] };
    const outcome = await check(root, python, ["a.py"], "abc", undefined);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, "bad: a.py");
  });

  test("runs a program of the PATH", async () => {
    const git = { ...LINT, run: ["git", "--version"] };
    const outcome = await check(root, git, ["a.go"], "abc", undefined);
    assert.equal(outcome.ok, true);
    assert.match(outcome.output, /^git version/);
  });

  test("strips the colours a tool prints despite NO_COLOR, and the root from the paths it names", async () => {
    const coloured = `\x1b[31m${join(root, "src", "a.ts")}\x1b[0m: bad\n`;
    tool(`process.stdout.write(${JSON.stringify(coloured)}); process.exit(1)`);
    const outcome = await check(root, { ...LINT, run: ["tool.mjs"] }, ["a.ts"], "abc", undefined);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, `${join("src", "a.ts")}: bad`);
  });

  test("fails when its command is not installed, instead of breaking the whole check", async () => {
    const missing = { ...LINT, run: ["no-such-tool", "{files}"] };
    const outcome = await check(root, missing, ["a.ts"], "abc", undefined);
    assert.equal(outcome.ok, false);
    assert.match(outcome.output, /no-such-tool is not installed/);
  });

  test("says the exit code of a gate that fails without a word, instead of an empty report", async () => {
    tool("process.exit(3)");
    const outcome = await check(root, { ...LINT, run: ["tool.mjs"] }, ["a.ts"], "abc", undefined);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, "exit code 3, no output");
  });

  test("fails on a report too long to read, and says so instead of a timeout", async () => {
    tool('process.stdout.write("x".repeat(17 * 1024 * 1024))');
    const outcome = await check(root, COMPARED, [], "abc", undefined);
    assert.equal(outcome.ok, false);
    assert.match(outcome.output, /more than 16 MB/);
  });
});

describe("check, compared with the turn start", () => {
  test("fails on the lines the turn added only, and keeps the whole report", async () => {
    tool('console.log("old\\nfresh")');
    const outcome = await check(root, COMPARED, [], "abc", "old");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, "fresh");
    assert.equal(outcome.report, "old\nfresh");
  });

  test("fails when the command breaks, even with the output it printed as the turn started", async () => {
    tool('console.log("boom"); process.exit(2)');
    const outcome = await check(root, COMPARED, [], "abc", "boom");
    assert.equal(outcome.ok, false);
    assert.equal(outcome.output, "boom");
    assert.equal(outcome.report, undefined);
  });

  test("fails when the command times out, even if it timed out as the turn started", async () => {
    tool("setTimeout(() => {}, 10_000)");
    const slow = { ...COMPARED, timeoutSeconds: 0.2 };
    const outcome = await check(root, slow, [], "abc", (await wholeProject(root, slow)).output);
    assert.equal(outcome.ok, false);
    assert.match(outcome.output, /Timed out/);
  });
});
