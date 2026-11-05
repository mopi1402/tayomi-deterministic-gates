import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import type { CheckedTurn } from "./check.ts";
import { duration, excerpt, failures, summary } from "./report.ts";
import type { Outcome } from "./run.ts";

function outcome(name: string, ok: boolean, ms: number): Outcome {
  return { name, ok, ms, output: `${name} report`, report: `${name} report` };
}

function ran(outcomes: Outcome[], skipped: string[] = [], ms = 20): CheckedTurn {
  return { changed: ["src/a.ts"], outcomes, skipped, ms };
}

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

  test("names the gates the turn did not concern, after the passes", () => {
    const lines = shown(summary(ran([outcome("lint", true, 2000)], ["tests", "clones"], 2100)));
    assert.equal(lines[0], "● gates  1/1 gates green in 2.1 s · 2 skipped");
    assert.equal(lines.at(-1), "- tests  - clones  · no matching file changed");
  });

  test("says when the agent handed back with a gate still failing", () => {
    assert.match(
      shown(summary(ran([outcome("lint", false, 10)]), "the agent handed back anyway"))[0] ?? "",
      /the agent handed back anyway$/,
    );
  });

  test("says when the turn changed no file", () => {
    const turn = { changed: [], outcomes: [], skipped: ["lint"], ms: 5 };
    assert.deepEqual(shown(summary(turn)), ["● gates", "✓ no file changed"]);
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

  test("tells the agent to fix the code, never the check, and to hand back on a wrong report", () => {
    const text = failures(ran([outcome("lint", false, 10)]));
    assert.match(text, /Fix the code, never the check: a silenced rule \(noqa, eslint-disable, nolint\)/);
    assert.match(text, /If a report is wrong, or contradicts what you were asked, say so to the owner and hand back\./);
  });

  test("passes the note of the check on, so the agent learns its gates edit did not count", () => {
    const note = "the turn changed .gates.json: checked with the gates as the turn started";
    const text = failures({ ...ran([outcome("lint", false, 10)]), note });
    assert.ok(text.includes(`\n\n${note}\n\n## lint`));
  });
});
