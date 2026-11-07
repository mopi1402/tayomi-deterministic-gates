import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { relatedTests } from "./related-tests.ts";
import report from "./test-reporter.ts";
import { tempRepo } from "../testing.ts";

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
  repo = tempRepo();
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

  test("ignores an import of types only, which the type check covers and nothing runs", () => {
    write({
      "src/a.ts": "export interface A { n: number }\nexport const a = 1;",
      "src/types-test.ts": 'import type { A } from "./a.ts";\nconst x: A = { n: 1 };\nconsole.log(x);',
      "src/value-test.ts": 'import { a } from "./a.ts";\nconsole.log(a);',
    });
    assert.deepEqual(relatedTests(repo, ["src/a.ts"], NODE_TESTS), ["src/value-test.ts"]);
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
  function helper(...changed: string[]) {
    return spawnSync(process.execPath, [HELPER, "--tests", "-test\\.ts$", ...changed], { cwd: repo, encoding: "utf8" });
  }

  test("runs only the related tests with node, and fails as they do", () => {
    write({
      "src/a.ts": "export const a = 1;",
      "src/a-test.ts":
        'import { test } from "node:test";\nimport { a } from "./a.ts";\ntest("a", () => { if (a !== 2) throw new Error("a is not 2"); });',
      "src/c-test.ts": 'import { test } from "node:test";\ntest("c", () => { throw new Error("never run"); });',
    });
    const run = helper("src/a.ts");
    assert.equal(run.status, 1);
    assert.match(run.stdout, /a is not 2/);
    assert.doesNotMatch(run.stdout, /never run/);
  });

  test("reports a module that does not compile once, with every test file it failed", () => {
    write({
      "src/a.ts": "export const a: number = ;",
      "src/x-test.ts":
        'import { test } from "node:test";\nimport { a } from "./a.ts";\ntest("x", () => { if (a !== 1) throw new Error("no"); });',
      "src/y-test.ts":
        'import { test } from "node:test";\nimport { a } from "./a.ts";\ntest("y", () => { if (a !== 1) throw new Error("no"); });',
    });
    const run = helper("src/a.ts");
    assert.equal(run.status, 1);
    assert.match(run.stdout, /^✖ src\/x-test\.ts, src\/y-test\.ts\nsrc\/a\.ts:1\n/);
    assert.equal(run.stdout.split("Expression expected").length, 2);
    assert.doesNotMatch(run.stdout, /node:internal/);
  });

  test("passes, and says nothing, when no test is related", () => {
    write({ "src/a.ts": "export const a = 1;", "src/c-test.ts": "" });
    const run = helper("src/a.ts");
    assert.equal(run.status, 0);
    assert.equal(run.stdout, "");
  });
});

describe("the reporter", () => {
  async function printed(events: object[]): Promise<string> {
    let text = "";
    const source = (async function* () {
      yield* events;
    })();
    for await (const chunk of report(source as never)) text += chunk;
    return text;
  }

  test("prints a distinct failure once with the tests it hit, without the frames of Node, and skips the parents", async () => {
    const file = join(process.cwd(), "src/v.test.ts");
    const cause = new Error("1 !== 2");
    cause.stack = `AssertionError: 1 !== 2\n    at TestContext.<anonymous> (file://${file}:3:81)\n    at Test.runInAsyncScope (node:async_hooks:227:14)\n    at new Promise (<anonymous>)`;
    const fail = (name: string, nesting: number, error: object, at = file) => ({
      type: "test:fail",
      data: { name, nesting, file: at, details: { error } },
    });
    const crashed = (name: string) => [
      { type: "test:stderr", data: { name, nesting: 0, file: name, message: "node:internal/modules/run_main:107\n" } },
      {
        type: "test:stderr",
        data: { name, nesting: 0, file: name, message: "    triggerUncaughtException(\n    ^\n\n" },
      },
      { type: "test:stderr", data: { name, nesting: 0, file: name, message: "SyntaxError: Expression expected\n" } },
      {
        type: "test:stderr",
        data: { name, nesting: 0, file: name, message: "    at parse (node:internal/modules/typescript:72:36)\n" },
      },
      { type: "test:start", data: { name, nesting: 0, file: name } },
      fail(name, 0, { failureType: "testCodeFailure", message: "test failed" }, name),
    ];
    const text = await printed([
      { type: "test:start", data: { name: "outer", nesting: 0, file } },
      { type: "test:start", data: { name: "deep", nesting: 1, file } },
      fail("deep", 1, { failureType: "testCodeFailure", message: "1 !== 2", cause }),
      fail("outer", 0, { failureType: "subtestsFailed", message: "1 subtest failed" }),
      ...crashed("src/x.test.ts"),
      ...crashed("src/y.test.ts"),
      { type: "test:summary", data: { name: "", nesting: 0, counts: { tests: 3, failed: 3 } } },
    ]);
    assert.equal(
      text,
      [
        "✖ src/v.test.ts: outer > deep",
        "AssertionError: 1 !== 2",
        "    at TestContext.<anonymous> (src/v.test.ts:3:81)",
        "",
        "✖ src/x.test.ts, src/y.test.ts",
        "SyntaxError: Expression expected",
        "",
        "3 tests, 3 failed",
        "",
      ].join("\n"),
    );
  });
});
