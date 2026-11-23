import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Gate } from "./config.ts";
import {
  argumentsOf,
  type Command,
  check,
  commandOf,
  failed,
  filesOf,
  missingTool,
  newLines,
  wholeProject,
} from "./run.ts";

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

describe("missingTool", () => {
  const gate = (name: string): Gate => ({ ...LINT, run: [name] });

  test("finds a program on the PATH, a package of node_modules, a script of the engine, and Node for a script", () => {
    mkdirSync(join(root, "node_modules", "eslint"), { recursive: true });
    writeFileSync(join(root, "node_modules", "eslint", "package.json"), JSON.stringify({ bin: "./bin/eslint.js" }));
    for (const name of ["git", "eslint", "{engine}/src/helpers/new-clones.ts", "scripts/tool.mjs"])
      assert.equal(missingTool(root, gate(name)), undefined, name);
  });

  test("says why a program is missing from the PATH, or from its path in the repo", () => {
    assert.match(missingTool(root, gate("no-such-tool")) ?? "", /no-such-tool is not installed/);
    assert.match(missingTool(root, gate(".venv/bin/ruff")) ?? "", /\.venv\/bin\/ruff does not exist/);
  });
});

describe("newLines", () => {
  test("keeps only the lines the turn added, less the ignored ones", () => {
    const before = "Unused exports (1)\nsrc/a.ts: old";
    const after = "Unused exports (2)\nsrc/a.ts: old\nsrc/b.ts: fresh\n";
    assert.deepEqual(newLines(before, after, "\\(\\d+\\)$"), ["src/b.ts: fresh"]);
  });

  const KEY = "^[^\\t]*";

  test("tells a line by its key when the gate gives one, whatever the rest of it says", () => {
    const before = "src/a.ts: TS1 at `x`\tType 'A | B'";
    const after = "src/a.ts: TS1 at `x`\tType 'B | A'\nsrc/a.ts: TS1 at `y`\tType 'C'";
    assert.deepEqual(newLines(before, after, undefined, KEY), ["src/a.ts: TS1 at `y`\tType 'C'"]);
  });

  test("keeps as old a line of a new key that says the same as a line of the turn start whose key went", () => {
    const before = "src/a.ts: TS2 at `for (x of a)`\tNot iterable\nsrc/a.ts: TS1 at `z`\tOld";
    const after = [
      "src/b.ts: TS2 at `for (y of b)`\tNot iterable",
      "src/a.ts: TS1 at `z`\tOld",
      "src/c.ts: TS2 at `for (w of c)`\tNot iterable",
    ].join("\n");
    assert.deepEqual(newLines(before, after, undefined, KEY), ["src/c.ts: TS2 at `for (w of c)`\tNot iterable"]);
  });

  test("keeps as old a line of a new key whose place, the first group of the key, lost a line, one for one", () => {
    const PLACE = "^(.+?: TS\\d+) at [^\\t]*";
    const before =
      "src/a.ts: TS1 at `let x = a;`\tType '{ a: 1; b: 2; }'\nsrc/b.ts: TS2 at `for (v of b)`\tNot iterable";
    const after = [
      "src/a.ts: TS1 at `let y = a;`\tType '{ b: 2; a: 1; }'",
      "src/a.ts: TS1 at `let z = b;`\tType 'B'",
      "src/a.ts: TS2 at `for (w of a)`\tNot iterable",
      "src/b.ts: TS2 at `for (u of b)`\tNot what it was",
    ].join("\n");
    assert.deepEqual(newLines(before, after, undefined, PLACE), [
      "src/a.ts: TS1 at `let z = b;`\tType 'B'",
      "src/b.ts: TS2 at `for (u of b)`\tNot what it was",
    ]);
  });

  test("never keeps as reported elsewhere a line of a file the turn changed, which the file group of the key names", () => {
    const FILE = "^((?<file>.+?): TS\\d+) at [^\\t]*";
    const before = "src/a.ts: TS1 at `let x = a;`\tMaybe undefined\nsrc/c.ts: TS2 at `for (v of c)`\tNot iterable";
    const after = "src/b.ts: TS1 at `let y = b;`\tMaybe undefined\nsrc/d.ts: TS2 at `for (w of d)`\tNot iterable";
    assert.deepEqual(newLines(before, after, undefined, FILE, ["src/a.ts", "src/b.ts"]), [
      "src/b.ts: TS1 at `let y = b;`\tMaybe undefined",
    ]);
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

  test("runs a package and a script of the repo on the Node the repo pins, and its tools with node_modules/.bin first", async () => {
    // A repo may pin its Node as a package, which npx finds first: here one that says it was used.
    mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
    const node = join(root, "node_modules", ".bin", "node");
    writeFileSync(node, `#!/bin/sh\nPINNED=yes exec "${process.execPath}" "$@"\n`);
    chmodSync(node, 0o755);
    mkdirSync(join(root, "node_modules", "say"));
    writeFileSync(join(root, "node_modules", "say", "package.json"), JSON.stringify({ bin: "say.mjs" }));
    const says =
      'import { delimiter } from "node:path"; console.log(process.env.PINNED, process.env.PATH.split(delimiter)[0])';
    writeFileSync(join(root, "node_modules", "say", "say.mjs"), says);
    tool(says);
    const bin = join("node_modules", ".bin");
    for (const name of ["say", "tool.mjs"]) {
      const outcome = await check(root, { ...LINT, run: [name] }, ["a.ts"], "abc", undefined);
      assert.equal(outcome.output, `yes ${bin}`, name);
    }
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

  test("neither passes nor fails when the command runs out of time, even if it did as the turn started", async () => {
    tool("setTimeout(() => {}, 10_000)");
    const slow = { ...COMPARED, timeoutSeconds: 0.2 };
    const outcome = await check(root, slow, [], "abc", (await wholeProject(root, slow)).output);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.timedOut, true);
    assert.equal(failed(outcome), false);
    assert.match(outcome.output, /Out of time after 0\.2 s, so not judged/);
  });
});
