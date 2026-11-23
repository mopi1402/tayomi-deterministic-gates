import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { typeErrors, watching } from "./type-errors.ts";

const SOURCE = "export function first(items: string[]): string {\n  const found: string = items.find(Boolean);\n}\n";
const sources = (files: Record<string, string>) => (file: string) => files[file];
const UNDEFINED = [
  "a.ts(2,9): error TS2322: Type 'string | undefined' is not assignable to type 'string'.",
  "  Type 'undefined' is not assignable to type 'string'.",
];
const ONE_LINE =
  "a.ts: error TS2322 at `const found: string = items.find(Boolean);`\tType 'string | undefined' is not assignable to type 'string'.";
const key = (line: string) => line.split("\t")[0];

describe("the type errors of tsc", () => {
  test("print each error on one line: its file, code and source line, then its first line of message", () => {
    assert.deepEqual(typeErrors(UNDEFINED, sources({ "a.ts": SOURCE })), [ONE_LINE]);
  });

  test("tell an error by its source line, however tsc prints its types and wherever a change moves it", () => {
    const initial = [
      `a.ts(2,9): error TS2322: Type '{ count: number; 'b-c'?: "y" | "x"; name: string; }' is not assignable to type 'Row'.`,
    ];
    const incremental = [
      `a.ts(4,9): error TS2322: Type '{ name: string; count: number; 'b-c'?: "x" | "y"; }' is not assignable to type 'Row'.`,
    ];
    const [before = ""] = typeErrors(initial, sources({ "a.ts": SOURCE }));
    const [after = ""] = typeErrors(incremental, sources({ "a.ts": `// one\n// two\n${SOURCE}` }));
    assert.equal(key(after), key(before));
    assert.equal(key(before), "a.ts: error TS2322 at `const found: string = items.find(Boolean);`");
  });

  test("count an error a file already has on the same source, so that one more of it is new", () => {
    const again = UNDEFINED.map((line) => line.replace("(2,9)", "(3,9)"));
    const twice = SOURCE.replace("}\n", "  const found: string = items.find(Boolean);\n}\n");
    assert.deepEqual(typeErrors([...UNDEFINED, ...again], sources({ "a.ts": twice })).map(key), [
      key(ONE_LINE),
      `${key(ONE_LINE)} (2)`,
    ]);
  });

  test("cut a long message, which only the agent reads", () => {
    const long = `a.ts(2,9): error TS2322: Type '${"x".repeat(400)}' is not assignable to type 'string'.`;
    const [line = ""] = typeErrors([long], sources({ "a.ts": SOURCE }));
    assert.equal(line.split("\t")[1]?.length, 301);
    assert.ok(line.endsWith("…"));
  });

  test("keep an error of no file as tsc prints it", () => {
    assert.deepEqual(typeErrors(["error TS5083: Cannot read file 'tsconfig.base.json'.", ""], sources({})), [
      "error TS5083: Cannot read file 'tsconfig.base.json'.",
    ]);
  });

  test("of a watch, print each compilation between a line that starts it and one that ends it", () => {
    const watch = watching(sources({ "a.ts": SOURCE }));
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
