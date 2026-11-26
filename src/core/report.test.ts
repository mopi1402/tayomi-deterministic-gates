import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { outcome, ran } from "../testing.ts";
import { duration, excerpt, failures, results, summary, toolsToInstall } from "./report.ts";

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

  test("cuts a long list between two lines, and counts the lines cut", () => {
    const lines = Array.from({ length: 200 }, (_, at) => `src/file-${at}.ts:1-9 ~ src/other-${at}.ts:20-28`);
    const kept = excerpt(lines.join("\n")).split("\n");
    const cut = kept.findIndex((line) => line.startsWith("[..."));
    assert.equal(kept[cut], `[... ${200 - (kept.length - 1)} lines cut ...]`);
    assert.deepEqual(kept.slice(0, cut), lines.slice(0, cut));
    assert.deepEqual(kept.slice(cut + 1), lines.slice(cut + 1 - kept.length));
    assert.ok(kept.join("\n").length < 4100);
  });

  test("cuts inside a line too long to keep whole, where dropping it would leave almost nothing", () => {
    const kept = excerpt(`FAIL test a\nAssertionError: ${"x".repeat(10_000)}\n1 failed`);
    assert.ok(kept.startsWith("FAIL test a\nAssertionError: xxx"));
    assert.ok(kept.endsWith("xxx\n1 failed"));
    assert.match(kept, /characters cut/);
    assert.ok(kept.length > 3900 && kept.length < 4100, String(kept.length));
  });

  test("keeps as many characters as it is given", () => {
    const lines = Array.from({ length: 200 }, (_, at) => `clone ${at}`);
    assert.ok(excerpt(lines.join("\n"), 300).length < 340);
    assert.equal(excerpt(lines.join("\n"), 100_000), lines.join("\n"));
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
  const listed = (count: number, line: string) => Array.from({ length: count }, (_, at) => `${line} ${at}`).join("\n");

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

  test("adds the prompt of the repo to what it tells the agent, or says it instead, and always how to waive", () => {
    const turn = ran([outcome("lint", false, 10)]);
    const added = failures({
      ...turn,
      wording: { prompts: { sendBack: { text: "Ask before a refactor.", replace: false } } },
    });
    assert.match(added, /settle a question first\.\n\nAsk before a refactor\.\n\nTo leave a gate red, waive it/);
    const replaced = failures({
      ...turn,
      wording: { prompts: { sendBack: { text: "Ask the owner.", replace: true } } },
    });
    assert.ok(replaced.startsWith("Ask the owner.\n\nTo leave a gate red, waive it"));
    assert.doesNotMatch(replaced, /Fix the code, never the check/);
    assert.match(replaced, /^\[deterministic-gates:<gate>\]: waive "<reason>"$/m);
  });

  test("gives the prompt of a gate under its name, before its report", () => {
    const turn = ran([outcome("lint", false, 10), outcome("tests", false, 10)]);
    const gates = [{ name: "lint", prompt: { text: "Never edit src/generated.", replace: false } }];
    const text = failures({ ...turn, wording: { gates } });
    assert.match(text, /## lint\nNever edit src\/generated\.\nlint report/);
    assert.match(text, /## tests\ntests report/);
  });

  test("keeps of the report of a gate the characters the repo gives it", () => {
    const long = { ...outcome("clones", false), output: listed(200, "clone") };
    const text = failures({ ...ran([long]), wording: { gates: [{ name: "clones", maxReportChars: 300 }] } });
    assert.match(text, /## clones\nclone 0\n/);
    assert.match(text, /lines cut/);
    assert.ok(text.slice(text.indexOf("## clones")).length < 360);
  });

  test("says once the lines a helper counts apart, with how many times, and leaves the other lines as they are", () => {
    const at = "gate-probe.ts: error TS2339 at `left = this.min ? this.min : this.max;`";
    const strict = {
      ...outcome("strict", false),
      output: [
        "",
        "",
        `${at}\tProperty 'min' does not exist.`,
        `${at} (2)\tProperty 'min' does not exist.`,
        `${at} (3)\tProperty 'max' does not exist.`,
        `${at} (4)\tProperty 'max' does not exist.`,
        `other.ts: error TS1 at \`x\` (2)\tAlone.`,
      ].join("\n"),
    };
    const sent = failures(ran([strict]));
    assert.ok(
      sent.endsWith(
        [
          "## strict",
          "",
          "",
          `${at}\tProperty 'min' does not exist. (×2)`,
          `${at}\tProperty 'max' does not exist. (×2)`,
          "other.ts: error TS1 at `x`\tAlone.",
        ].join("\n"),
      ),
      sent,
    );
  });

  test("leaves the lines of any other tool as they are, however alike, and their tabs", () => {
    const frame = "\tat org.junit.Runner.run(Runner.java:9)";
    const output = ["First", frame, "\t}", "Second", frame, "\t}", "\ta_test.go:10: got 1 (2)\twant 3"].join("\n");
    assert.ok(failures(ran([{ ...outcome("tests", false), output }])).endsWith(`## tests\n${output}`));
  });

  test("omits lines by what the gate printed, before it says once the ones a helper counts apart", () => {
    const at = "a.ts: error TS1 at `x`";
    const strict = { ...outcome("strict", false), output: `${at}\tKept.\n${at} (2)\tKept.\n${at} (3)\tGone.` };
    const sent = failures({ ...ran([strict]), wording: { gates: [{ name: "strict", omitLines: "Gone\\.$" }] } });
    assert.ok(sent.endsWith(`## strict\n${at}\tKept. (×2)`), sent);
  });

  test("says a long report once in a time that grows with it, not with its square", () => {
    const output = Array.from({ length: 200_000 }, (_, at) => `\tline ${at}`).join("\n");
    const started = performance.now();
    failures(ran([{ ...outcome("tests", false), output }]));
    assert.ok(performance.now() - started < 2000);
  });

  test("leaves out of a report the lines the gate omits, unless none would be left", () => {
    const stack = {
      ...outcome("lint", false),
      output: "TypeError: x is not a function\n    at f (a.ts:1)\n    at g (b.ts:2)",
    };
    const omitting = (omitLines: string) =>
      failures({ ...ran([stack]), wording: { gates: [{ name: "lint", omitLines }] } });
    assert.ok(omitting("^\\s+at ").endsWith("## lint\nTypeError: x is not a function"));
    assert.ok(omitting(".").endsWith(`## lint\n${stack.output}`));
  });

  test("shares the characters of a send-back between its reports, a short one whole and the long ones cut alike", () => {
    const long = (name: string) => ({ ...outcome(name, false), output: listed(300, `${name} problem`) });
    const turn = ran([long("lint"), outcome("dead", false), long("tests")]);
    const text = failures({ ...turn, wording: { maxTotalReportChars: 1000 } });
    const [, lint = "", dead = "", tests = ""] = text.split("## ");
    assert.equal(dead.trim(), "dead\ndead report");
    for (const report of [lint, tests]) assert.ok(report.length > 400 && report.length < 560, String(report.length));
    assert.match(lint, /lines cut/);
  });

  test("says it in one line once the session was told how to act, and still how to waive", () => {
    const text = failures(ran([outcome("lint", false, 10)]), ["This is send-back 2 of 5."], true);
    const [head = "", ...rest] = text.split("\n\n");
    assert.ok(head.length < 200, String(head.length));
    assert.match(head, /\[deterministic-gates:<gate>\]: waive "<reason>"/);
    assert.doesNotMatch(text, /a silenced rule/);
    assert.deepEqual(rest, ["This is send-back 2 of 5.", "## lint\nlint report"]);
  });

  test("tells the agent to repair a gate that broke, in the words of the engine or of the repo", () => {
    const turn = ran([{ ...outcome("types", false), broken: true }, outcome("lint", false)]);
    const text = failures(turn);
    assert.match(
      text,
      /## types\nThis gate broke instead of reporting: repair what stops it from running.*\ntypes report/,
    );
    assert.match(text, /## lint\nlint report/);
    const replaced = failures({
      ...turn,
      wording: { prompts: { brokenGate: { text: "Run pnpm install.", replace: true } } },
    });
    assert.match(replaced, /## types\nRun pnpm install\.\ntypes report/);
  });
});

describe("toolsToInstall", () => {
  test("names the missing tools, then asks to install them unless the repo says otherwise", () => {
    assert.match(toolsToInstall(["lint: eslint is not installed"]), /- lint: eslint is not installed\nInstall these/);
    const added = toolsToInstall(["lint: x"], { text: "Use pnpm.", replace: false });
    assert.match(added, /every other gate still runs\.\nUse pnpm\.$/);
    assert.equal(
      toolsToInstall(["lint: x"], { text: "Tell the owner.", replace: true }),
      "Some gates of this repo cannot run on this machine, for a missing tool:\n- lint: x\nTell the owner.",
    );
  });
});

describe("results", () => {
  test("give each gate of a check a status, with its report when it failed or broke, for a tool to read", () => {
    const turn = {
      ...ran(
        [
          outcome("lint", false, 900),
          outcome("typecheck", true, 1100),
          { ...outcome("tests", false, 40), output: "Cannot find module", broken: true },
          { ...outcome("clones", false, 5000), timedOut: true },
        ],
        ["format"],
        7040,
      ),
      note: "dead not run, its entry is wrong: run is missing\nthe turn changed .gates.json",
    };
    assert.deepEqual(results(turn), {
      ok: false,
      durationMs: 7040,
      gates: [
        { name: "lint", status: "failed", durationMs: 900, report: "lint report" },
        { name: "typecheck", status: "passed", durationMs: 1100 },
        { name: "tests", status: "broken", durationMs: 40, report: "Cannot find module" },
        { name: "clones", status: "timed-out", durationMs: 5000 },
        { name: "format", status: "skipped" },
      ],
      notes: ["dead not run, its entry is wrong: run is missing", "the turn changed .gates.json"],
    });
  });

  test("are ok when no gate failed, a gate out of time included", () => {
    const turn = ran([outcome("lint", true, 10), { ...outcome("clones", false, 5000), timedOut: true }]);
    assert.deepEqual(results(turn), {
      ok: true,
      durationMs: 20,
      gates: [
        { name: "lint", status: "passed", durationMs: 10 },
        { name: "clones", status: "timed-out", durationMs: 5000 },
      ],
      notes: [],
    });
  });
});
