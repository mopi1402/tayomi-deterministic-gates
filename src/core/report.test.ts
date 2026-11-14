import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { outcome, ran } from "../testing.ts";
import { duration, excerpt, failures, summary } from "./report.ts";

const shown = (text: string) => stripVTControlCharacters(text).split("\n");

describe("duration", () => {
  test("reads in milliseconds under a second, in seconds above", () => {
    assert.equal(duration(404.4), "404 ms");
    assert.equal(duration(5012), "5.0 s");
  });
});

describe("excerpt", () => {
  test("keeps a short report whole", () => {
    assert.equal(excerpt("lint report"), "lint report");
  });

  test("keeps the start and the end of a long report, where tools put the problem", () => {
    const kept = excerpt(`first line${"x".repeat(10_000)}last line`);
    assert.ok(kept.startsWith("first line"));
    assert.ok(kept.endsWith("last line"));
    assert.match(kept, /characters cut/);
    assert.ok(kept.length < 4100);
  });
});

describe("summary", () => {
  test("totals, then each failure, then the passes on one line, slowest first", () => {
    const outcomes = [outcome("lint", true, 300), outcome("tests", false, 5000), outcome("clones", true, 900)];
    assert.deepEqual(shown(summary(ran(outcomes, [], 5100), "the agent is sent back to fix it")), [
      "● gates  2/3 gates green in 5.1 s · the agent is sent back to fix it",
      "✗ tests 5.0 s",
      "✓ clones 900 ms  ✓ lint 300 ms",
    ]);
  });

  test("names six passes, then counts the rest", () => {
    const outcomes = Array.from({ length: 8 }, (_, index) => outcome(`i${index}`, true, 100 - index));
    assert.match(shown(summary(ran(outcomes, [], 200))).at(-1) ?? "", /✓ i5 95 ms {2}\.\.\. \+2$/);
  });

  test("names every pass, six to a line, when the repo asks for all of them", () => {
    const outcomes = Array.from({ length: 8 }, (_, index) => outcome(`i${index}`, true, 100 - index));
    assert.deepEqual(shown(summary({ ...ran(outcomes, [], 200), showAllPasses: true })).slice(1), [
      "✓ i0 100 ms  ✓ i1 99 ms  ✓ i2 98 ms  ✓ i3 97 ms  ✓ i4 96 ms  ✓ i5 95 ms",
      "✓ i6 94 ms  ✓ i7 93 ms",
    ]);
  });

  test("names the gates the turn did not concern, after the passes", () => {
    const lines = shown(summary(ran([outcome("lint", true, 2000)], ["tests", "clones"], 2100)));
    assert.equal(lines[0], "● gates  1/1 gates green in 2.1 s · 2 skipped");
    assert.equal(lines.at(-1), "- tests  - clones  · no matching file changed");
  });

  test("says how the stop ends, even when every gate passes", () => {
    assert.match(
      shown(summary(ran([outcome("lint", false, 10)]), "stopped after 5 send-backs"))[0] ?? "",
      /5 send-backs$/,
    );
    assert.match(
      shown(summary(ran([outcome("lint", true, 10)]), "after 1 send-back"))[0] ?? "",
      /· after 1 send-back$/,
    );
  });

  test("says when the turn changed no file", () => {
    const turn = { changed: [], outcomes: [], skipped: ["lint"], ms: 5 };
    assert.deepEqual(shown(summary(turn)), ["● gates", "✓ no file changed"]);
    assert.deepEqual(shown(summary(turn, "after 1 send-back"))[0], "● gates · after 1 send-back");
  });

  test("says when the turn changed files no gate looks at, and names the skipped ones", () => {
    const turn = { changed: ["a.swift", "b.md"], outcomes: [], skipped: ["lint"], ms: 5 };
    assert.deepEqual(shown(summary(turn)), [
      "● gates  no gate looks at the 2 changed files",
      "- lint  · no matching file changed",
    ]);
  });

  test("ends with the note of the check", () => {
    const turn = { ...ran([outcome("lint", true, 10)]), note: "no turn start recorded" };
    assert.equal(shown(summary(turn)).at(-1), "no turn start recorded");
  });
});

describe("failures", () => {
  test("gives the report of each failed gate only", () => {
    const text = failures(ran([outcome("lint", false, 10), outcome("dead", true, 10)]));
    assert.match(text, /## lint\nlint report/);
    assert.doesNotMatch(text, /dead report/);
  });

  test("tells the agent to fix the code, never the check, and when and how to waive a gate instead", () => {
    const text = failures(ran([outcome("lint", false, 10)]), ["This is send-back 1 of 5."]);
    assert.match(text, /Fix the code, never the check: a silenced rule \(noqa, eslint-disable, nolint\)/);
    assert.match(text, /Leave a gate red only when it cannot be fixed/);
    assert.match(text, /goes against what the owner asked/);
    assert.match(text, /^\[deterministic-gates:<gate>\]: waive "<reason>"$/m);
    assert.match(text, /This is send-back 1 of 5\.\n\n## lint/);
  });

  test("passes the note of the check on, so the agent learns its gates edit did not count", () => {
    const note = "the turn changed .gates.json: checked with the gates as the turn started";
    const text = failures({ ...ran([outcome("lint", false, 10)]), note });
    assert.ok(text.includes(`\n\n${note}\n\n## lint`));
  });
});
