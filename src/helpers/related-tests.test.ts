import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { relatedTests } from "./related-tests.ts";

const HELPER = join(import.meta.dirname, "related-tests.ts");
const NODE_TESTS = /-test\.ts$/;

let repo = "";

function write(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gates-related-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("relatedTests", () => {
  test("finds the tests that import a changed file, directly or through other files, committed or not", () => {
    write({
      "src/a.ts": "export const a = 1;",
      "src/b.ts": 'import { a } from "./a.ts";\nexport const b = a;',
      "src/b-test.ts": 'import { b } from "./b.ts";\nconsole.log(b);',
      "src/c-test.ts": "console.log(1);",
      "src/d.test.ts": 'import { a } from "./a.ts";\nconsole.log(a);',
    });
    assert.deepEqual(relatedTests(repo, ["src/a.ts"], NODE_TESTS), ["src/b-test.ts"]);
  });

  test("counts a changed test itself, and an import written with a .js extension", () => {
    write({
      "src/a.ts": "export const a = 1;",
      "src/a-test.ts": 'import { a } from "./a.js";\nconsole.log(a);',
      "src/c-test.ts": "console.log(1);",
    });
    assert.deepEqual(relatedTests(repo, ["src/a.ts", "src/c-test.ts"], NODE_TESTS), ["src/a-test.ts", "src/c-test.ts"]);
  });

  test("follows an import of a folder to its index file", () => {
    write({
      "src/lib/index.ts": "export const a = 1;",
      "src/lib-test.ts": 'import { a } from "./lib";\nconsole.log(a);',
    });
    assert.deepEqual(relatedTests(repo, ["src/lib/index.ts"], NODE_TESTS), ["src/lib-test.ts"]);
  });

  test("survives an import cycle", () => {
    write({
      "src/a.ts": 'import "./b.ts";\nexport const a = 1;',
      "src/b.ts": 'import "./a.ts";\nexport const b = 1;',
      "src/b-test.ts": 'import { b } from "./b.ts";\nconsole.log(b);',
    });
    assert.deepEqual(relatedTests(repo, ["src/a.ts"], NODE_TESTS), ["src/b-test.ts"]);
  });
});

describe("the helper", () => {
  test("runs only the related tests with node, and fails as they do", () => {
    write({
      "src/a.ts": "export const a = 1;",
      "src/a-test.ts":
        'import { test } from "node:test";\nimport { a } from "./a.ts";\ntest("a", () => { if (a !== 2) throw new Error("a is not 2"); });',
      "src/c-test.ts": 'import { test } from "node:test";\ntest("c", () => { throw new Error("never run"); });',
    });
    const run = spawnSync(process.execPath, [HELPER, "--tests", "-test\\.ts$", "src/a.ts"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(run.status, 1);
    assert.match(run.stdout, /a is not 2/);
    assert.doesNotMatch(run.stdout, /never run/);
  });

  test("passes, and says nothing, when no test is related", () => {
    write({ "src/a.ts": "export const a = 1;", "src/c-test.ts": "" });
    const run = spawnSync(process.execPath, [HELPER, "--tests", "-test\\.ts$", "src/a.ts"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
  });
});
