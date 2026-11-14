import type { CheckedTurn } from "./check.ts";
import { failed, type Outcome } from "./run.ts";
import { WAIVE_TAG } from "./send-back.ts";

const LABEL = "● gates";
const SHOWN_PASSES = 6;
const REPORT_CHARS = 4000;
const HEAD_CHARS = 1000;

const TONES = { pass: "1;32", fail: "1;31", late: "1;33", warn: "1;38;5;208", dim: "2" } as const;
// The warning sign as text, never as the emoji some terminals draw without the variation selector.
const WARNING = "\u26A0\uFE0E";

/** A red gate the agent left on purpose, with the reason it gave. */
export interface Waived {
  name: string;
  reason: string;
}

function paint(tone: keyof typeof TONES, text: string): string {
  return `\x1b[${TONES[tone]}m${text}\x1b[0m`;
}

/** Keeps the start and the end of a long report: tools put the problem at one or the other. */
export function excerpt(report: string): string {
  if (report.length <= REPORT_CHARS) return report;
  const cut = report.length - REPORT_CHARS;
  return `${report.slice(0, HEAD_CHARS)}\n[... ${cut} characters cut ...]\n${report.slice(-(REPORT_CHARS - HEAD_CHARS))}`;
}

export function duration(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function gateLine(mark: string, outcome: Outcome): string {
  return `${mark} ${outcome.name} ${paint("dim", duration(outcome.ms))}`;
}

function skippedLine(skipped: string[]): string {
  return paint("dim", `${skipped.map((name) => `- ${name}`).join("  ")}  · no matching file changed`);
}

function nothingChecked({ changed, skipped }: CheckedTurn, after: string): string[] {
  if (!changed.length) return [`${paint("pass", LABEL)}${after}`, `${paint("pass", "✓")} no file changed`];
  const files = changed.length === 1 ? "1 changed file" : `${changed.length} changed files`;
  return [
    `${paint("pass", LABEL)}  no gate looks at the ${files}${after}`,
    ...(skipped.length ? [skippedLine(skipped)] : []),
  ];
}

// The gate in orange, then the reason the agent gave, under a star.
function waivedLines(outcome: Outcome, reason: string): string[] {
  return [
    `${paint("warn", `${WARNING} ${outcome.name}`)} ${paint("dim", duration(outcome.ms))}`,
    `  ${paint("warn", "*")} ${reason}`,
  ];
}

// Every pass, as many to a line as the summary shows by default; or the slowest of them, with a count of the rest.
function passLines(passed: Outcome[], showAll: boolean): string[] {
  const marked = passed.map((outcome) => gateLine(paint("pass", "✓"), outcome));
  if (showAll)
    return Array.from({ length: Math.ceil(marked.length / SHOWN_PASSES) }, (_, line) =>
      marked.slice(line * SHOWN_PASSES, (line + 1) * SHOWN_PASSES).join("  "),
    );
  const rest = marked.length - SHOWN_PASSES;
  return marked.length
    ? [[...marked.slice(0, SHOWN_PASSES), ...(rest > 0 ? [paint("dim", `... +${rest}`)] : [])].join("  ")]
    : [];
}

function resultLines(
  { outcomes, skipped, ms, showAllPasses = false }: CheckedTurn,
  after: string,
  waived: Waived[],
): string[] {
  const slowest = (a: Outcome, b: Outcome) => b.ms - a.ms;
  const reasons = new Map(waived.map(({ name, reason }) => [name, reason]));
  const failing = outcomes.filter(failed).sort(slowest);
  const red = failing.filter(({ name }) => !reasons.has(name));
  const left = failing.filter(({ name }) => reasons.has(name));
  const late = outcomes.filter((outcome) => outcome.timedOut).sort(slowest);
  const passed = outcomes.filter((outcome) => outcome.ok).sort(slowest);
  const leftOut = left.length ? ` · ${left.length} waived` : "";
  const outOfTime = late.length ? ` · ${late.length} out of time` : "";
  const notRun = skipped.length ? ` · ${skipped.length} skipped` : "";
  const tone = red.length ? "fail" : left.length ? "warn" : late.length ? "late" : "pass";
  const totals = `${passed.length}/${outcomes.length} gates green in ${duration(ms)}`;
  return [
    `${paint(tone, LABEL)}  ${totals}${leftOut}${outOfTime}${notRun}${after}`,
    ...red.map((outcome) => gateLine(paint("fail", "✗"), outcome)),
    ...left.flatMap((outcome) => waivedLines(outcome, reasons.get(outcome.name) ?? "")),
    ...late.map((outcome) => gateLine(paint("late", "⏱"), outcome)),
    ...passLines(passed, showAllPasses),
    ...(skipped.length ? [skippedLine(skipped)] : []),
  ];
}

/**
 * What the owner sees after every check, even when no gate ran, so a silent check never looks dead: one line of
 * totals, with how the stop ends, each failure, each gate the agent waived with its reason, the passes slowest
 * first, then the gates the turn did not concern.
 */
export function summary(turn: CheckedTurn, ending = "", waived: Waived[] = []): string {
  const after = ending ? ` · ${ending}` : "";
  const lines = turn.outcomes.length ? resultLines(turn, after, waived) : nothingChecked(turn, after);
  return [...lines, ...(turn.note ? [paint("dim", turn.note)] : [])].join("\n");
}

/** What the owner sees when the gates cannot run at all, such as with a gates file that does not parse. */
export function broken(reason: string): string {
  return `${paint("fail", LABEL)}  could not run: ${reason}`;
}

// The cheapest green is to silence the rule, and nothing in the engine judges a report. So the agent is told the one
// way out that is not a cheat: waive the gate, with a reason the owner reads and judges.
const CONDUCT = [
  "Fix the code, never the check: a silenced rule (noqa, eslint-disable, nolint), a weakened gate or an edited",
  ".gates.json does not pass this turn. If you can fix a problem, fix it. Leave a gate red only when it cannot be",
  "fixed (the report is wrong, or fixing it would loop until the last send-back), when fixing it goes against what",
  "the owner asked, or when the owner has to settle a question first. Then waive it in your final message, after a",
  "blank line, one line per gate, its reason in one line:",
].join(" ");

const WAIVE_SYNTAX = `[${WAIVE_TAG}:<gate>]: waive "<reason>"`;

/** What the owner sees when the gates of the repo miss tools on this machine, as the agent is asked to install them. */
export function toolsMissing(missing: string[]): string {
  const gates = missing.length === 1 ? "1 gate is off" : `${missing.length} gates are off`;
  const lines = missing.map((tool) => paint("dim", `- ${tool}`));
  return [`${paint("fail", LABEL)}  ${gates}, a tool is missing: the agent is asked to install it`, ...lines].join(
    "\n",
  );
}

/** What the agent is told when the gates of the repo miss tools: install them, or the gates that need them stay off. */
export function toolsToInstall(missing: string[]): string {
  return [
    "Some gates of this repo cannot run on this machine, for a missing tool:",
    ...missing.map((tool) => `- ${tool}`),
    "Install these tools first. If they cannot be installed, or the developer refuses, say so and go on with the",
    "prompt: the gates that need them stay off until they are installed, and every other gate still runs.",
  ].join("\n");
}

/** The report of each failed gate, under its name. */
export function reports(outcomes: Outcome[]): string[] {
  return outcomes.filter(failed).map(({ name, output }) => `## ${name}\n${excerpt(output)}`);
}

/**
 * What the agent gets when it is sent back: how to act on a failure, what the stop has to tell it, the note of the
 * check, each failed report.
 */
export function failures({ outcomes, note }: CheckedTurn, told: string[] = []): string {
  const head = ["Gates fail on what this turn changed. Fix every problem before you hand back.", CONDUCT, WAIVE_SYNTAX];
  return [...head, ...told, ...(note ? [note] : []), ...reports(outcomes)].join("\n\n");
}
