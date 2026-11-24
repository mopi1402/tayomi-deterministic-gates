import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newBulkSuppressions } from "./bulk-suppressions.ts";

const counts = (files: Record<string, Record<string, number>>) =>
  Object.fromEntries(
    Object.entries(files).map(([file, rules]) => [
      file,
      Object.fromEntries(Object.entries(rules).map(([rule, count]) => [rule, { count }])),
    ]),
  );

describe("newBulkSuppressions", () => {
  test("names each file whose count of a rule rose, when the turn suppressed more of the rule", () => {
    const before = counts({ "src/a.ts": { "no-console": 1 } });
    const after = counts({ "src/a.ts": { "no-console": 3 }, "src/b.ts": { "no-console": 1 } });
    assert.deepEqual(newBulkSuppressions(before, after), [
      "src/a.ts: no-console 1 -> 3",
      "src/b.ts: no-console 0 -> 1",
    ]);
  });

  test("leaves a file the turn moved, whose counts only changed place, and a count that fell", () => {
    const before = counts({ "src/a.ts": { "no-console": 2, eqeqeq: 4 } });
    const after = counts({ "src/moved.ts": { "no-console": 2, eqeqeq: 1 } });
    assert.deepEqual(
      newBulkSuppressions(before, after, (source) => source === "src/moved.ts"),
      [],
    );
  });

  test("names a count that rose in a file the turn did not move, even when the rule fell as much elsewhere", () => {
    const before = counts({ "src/a.ts": { "no-console": 5 }, "src/b.ts": { "no-console": 1 } });
    const after = counts({ "src/a.ts": { "no-console": 1 }, "src/b.ts": { "no-console": 5 } });
    assert.deepEqual(newBulkSuppressions(before, after), ["src/b.ts: no-console 1 -> 5"]);
  });

  test("names what a moved file suppresses beyond the counts that came with it", () => {
    const before = counts({ "src/a.ts": { "no-console": 2 } });
    const after = counts({ "src/moved.ts": { "no-console": 3 } });
    assert.deepEqual(
      newBulkSuppressions(before, after, () => true),
      ["src/moved.ts: no-console 0 -> 3"],
    );
  });

  test("counts each rule alone: one that fell never pays for another that rose", () => {
    const before = counts({ "src/a.ts": { eqeqeq: 2 } });
    assert.deepEqual(newBulkSuppressions(before, counts({ "src/a.ts": { "no-console": 2 } })), [
      "src/a.ts: no-console 0 -> 2",
    ]);
  });

  test("counts every suppression of a file the turn created", () => {
    assert.deepEqual(newBulkSuppressions(undefined, counts({ "src/a.ts": { eqeqeq: 1 } })), [
      "src/a.ts: eqeqeq 0 -> 1",
    ]);
  });

  test("refuses a file that is not one of ESLint", () => {
    assert.throws(() => newBulkSuppressions({}, { "src/a.ts": { eqeqeq: 2 } }), /Not an ESLint suppressions file/);
    assert.throws(() => newBulkSuppressions({}, []), /Not an ESLint suppressions file/);
  });
});
