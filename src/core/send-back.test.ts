import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { outcome, ran } from "../testing.ts";
import { fingerprint, judge, waivesOf } from "./send-back.ts";

describe("waivesOf", () => {
  test("reads each waive line of the message, with its reason between quotes or parentheses", () => {
    const message = [
      "I leave two gates red.",
      "",
      '[deterministic-gates:no-new-dead-code]: waive "isReady kept, as asked"',
      "[deterministic-gates:lint]: waive 'the rule contradicts the task'",
      "[deterministic-gates:tests]: waive (a question for you first)",
    ].join("\n");
    assert.deepEqual(waivesOf(message), [
      { gate: "no-new-dead-code", reason: "isReady kept, as asked" },
      { gate: "lint", reason: "the rule contradicts the task" },
      { gate: "tests", reason: "a question for you first" },
    ]);
  });

  test("reads nothing from another tag, prose, or a line with no reason", () => {
    const message = [
      '[view:lint]: waive "not ours"',
      'Write [deterministic-gates:lint]: waive "reason" to waive it.',
      "[deterministic-gates:lint]: waive",
    ].join("\n");
    assert.deepEqual(waivesOf(message), []);
  });
});

describe("fingerprint", () => {
  test("stays the same when only numbers move, and changes with what the report says", () => {
    assert.equal(
      fingerprint("src/a.ts:12 unused isReady\n  in 40 ms"),
      fingerprint("src/a.ts:15 unused isReady\nin 9 ms"),
    );
    assert.notEqual(fingerprint("src/a.ts:12 unused isReady"), fingerprint("src/a.ts:12 unused isDone"));
  });
});

describe("judge", () => {
  const red = (name: string, output: string) => ({ ...outcome(name, false), output });

  test("binds a waiver to the report of the last check, and lets it fall once the report changes", () => {
    const first = judge(ran([red("lint", "one")]), [], ["lint"], 5);
    assert.equal(first.sendBack, true);
    const same = judge(ran([red("lint", "one")]), [{ gate: "lint", reason: "r" }], ["lint"], 5, first.state);
    assert.equal(same.sendBack, false);
    assert.deepEqual(same.waived, [{ name: "lint", reason: "r" }]);
    const changed = judge(ran([red("lint", "two")]), [{ gate: "lint", reason: "r" }], ["lint"], 5, first.state);
    assert.equal(changed.sendBack, true);
    assert.deepEqual(changed.fallen, ["lint"]);
  });

  test("lets go a waive line for a gate that is not red, and names one no gate has", () => {
    const judged = judge(
      ran([outcome("lint", true)]),
      [
        { gate: "lint", reason: "r" },
        { gate: "nope", reason: "r" },
      ],
      ["lint"],
      5,
    );
    assert.deepEqual(judged.waived, []);
    assert.deepEqual(judged.unknown, ["nope"]);
    assert.deepEqual(judged.state.waivers, {});
  });

  test("stops sending back at the cap, and counts only the send-backs that happen", () => {
    const capped = judge(ran([outcome("lint", false)]), [], ["lint"], 2, { count: 2, waivers: {}, reports: {} });
    assert.equal(capped.sendBack, false);
    assert.equal(capped.count, 2);
  });
});
