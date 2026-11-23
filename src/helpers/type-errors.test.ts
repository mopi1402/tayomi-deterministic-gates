import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { typeErrors, watching } from "./type-errors.ts";

const UNDEFINED = [
  "a.ts(2,47): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "  Type 'undefined' is not assignable to type 'string'.",
];
const ONE_LINE = "a.ts: error TS2322: Type 'string | undefined' is not assignable to type 'string'.";

describe("the type errors of tsc", () => {
  test("print each error on one line, with its file and none of its line and column, nor the lines that explain it", () => {
    assert.deepEqual(typeErrors(UNDEFINED), [ONE_LINE]);
  });

  test("count an error a file already has, so that one more of it is new", () => {
    const again = UNDEFINED.map((line) => line.replace("(2,47)", "(9,3)"));
    assert.deepEqual(typeErrors([...UNDEFINED, ...again]), [ONE_LINE, `${ONE_LINE} (2)`]);
  });

  test("print an error the same whatever order tsc gave the members of its unions", () => {
    const initial = [
      `a.ts(3,5): error TS2322: Type '"failed" | "LOH" | { kind: "b" | "a"; tags?: Set<"y" | "x">; on: Set<(a: "y" | "x") => 1 | 0> } | undefined' is not assignable to type 'Status'.`,
    ];
    const incremental = [
      `a.ts(3,5): error TS2322: Type '"failed" | { kind: "a" | "b"; tags?: Set<"x" | "y">; on: Set<(a: "x" | "y") => 0 | 1> } | undefined | "LOH"' is not assignable to type 'Status'.`,
    ];
    assert.deepEqual(typeErrors(initial), typeErrors(incremental));
    assert.deepEqual(typeErrors(initial), [
      `a.ts: error TS2322: Type '"LOH" | "failed" | undefined | { kind: "a" | "b"; tags?: Set<"x" | "y">; on: Set<(a: "x" | "y") => 0 | 1> }' is not assignable to type 'Status'.`,
    ]);
  });

  test("keep an error of no file as tsc prints it", () => {
    assert.deepEqual(typeErrors(["error TS5083: Cannot read file 'tsconfig.base.json'.", ""]), [
      "error TS5083: Cannot read file 'tsconfig.base.json'.",
    ]);
  });

  test("of a watch, print each compilation between a line that starts it and one that ends it", () => {
    const watch = watching();
    const printed = [
      "7:53:19 AM - Starting compilation in watch mode...",
      "",
      ...UNDEFINED,
      "",
      "7:53:19 AM - Found 1 error. Watching for file changes.",
      "",
      "7:53:22 AM - File change detected. Starting incremental compilation...",
      "",
      "7:53:22 AM - Found 0 errors. Watching for file changes.",
    ].flatMap(watch);
    assert.deepEqual(printed, [
      "Type check started",
      ONE_LINE,
      "Type check done",
      "Type check started",
      "Type check done",
    ]);
  });
});
