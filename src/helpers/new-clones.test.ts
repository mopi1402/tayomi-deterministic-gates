import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newClones } from "./new-clones.ts";

function clone(isNew: boolean | undefined, first: string, second: string) {
  return { isNew, firstFile: { name: first, start: 1, end: 9 }, secondFile: { name: second, start: 20, end: 28 } };
}

describe("newClones", () => {
  test("keeps only the clones the turn added, one line each", () => {
    const report = {
      duplicates: [clone(false, "old.ts", "older.ts"), clone(true, "a.tsx", "b.tsx"), clone(undefined, "c.ts", "d.ts")],
    };
    assert.deepEqual(newClones(report), ["a.tsx:1-9 ~ b.tsx:20-28"]);
  });

  test("refuses a report it cannot read", () => {
    assert.throws(() => newClones({ clones: [] }));
    assert.throws(() => newClones({ duplicates: [{ isNew: true, firstFile: { name: "a.ts" } }] }));
  });
});
