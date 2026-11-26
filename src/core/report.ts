import type { CheckedTurn } from "./check.ts";
import type { Prompt } from "./config.ts";
import { failed, type Outcome } from "./run.ts";
import { WAIVE_TAG } from "./waive-line.ts";

const LABEL = "● gates";
const SHOWN_PASSES = 6;
const REPORT_CHARS = 4000;
// The share of a cut report kept from its start.
const HEAD_SHARE = 0.25;

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

/**
 * Keeps the start and the end of a long report, in the characters given: tools put the problem at one or the other.
 * Each cut moves to the end of a line when that keeps at least half of its side, so a list keeps whole entries, and
 * stays inside a line longer than that, which would otherwise go whole.
 */
export function excerpt(report: string, max = REPORT_CHARS): string {
  if (report.length <= max) return report;
  const head = Math.floor(max * HEAD_SHARE);
  const tail = max - head;
  const before = report.lastIndexOf("\n", head - 1);
  const after = report.indexOf("\n", report.length - tail);
  const wholeHead = before >= head / 2;
  const wholeTail = after !== -1 && after - (report.length - tail) <= tail / 2;
  const end = wholeHead ? before : head;
  const start = wholeTail ? after + 1 : report.length - tail;
  const cut =
    wholeHead && wholeTail
      ? `${report.slice(end + 1, start - 1).split("\n").length} lines`
      : `${start - end} characters`;
  return `${report.slice(0, end)}\n[... ${cut} cut ...]\n${report.slice(start)}`;
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
const SEND_BACK = [
  "Gates fail on what this turn changed. Fix every problem before you hand back.\n\nFix the code, never the check: a silenced rule (noqa, eslint-disable, nolint), a weakened gate or an edited",
  ".gates.json does not pass this turn. If you can fix a problem, fix it. Leave a gate red only when it cannot be",
  "fixed (the report is wrong, or fixing it would loop until the last send-back), when fixing it goes against what",
  "the owner asked, or when the owner has to settle a question first.",
].join(" ");

const WAIVE_SYNTAX = `[${WAIVE_TAG}:<gate>]: waive "<reason>"`;

// Said whatever the repo says in place of the rest: without it, an agent could only loop on a gate it cannot fix.
const WAIVE = [
  "To leave a gate red, waive it in your final message, after a blank line, one line per gate, its reason in one line:",
  WAIVE_SYNTAX,
].join("\n");

// A gate that broke found no problem to fix: the agent looks for what stops it from running, in the code or around it.
const BROKEN_GATE =
  "This gate broke instead of reporting: repair what stops it from running (a missing dependency, a broken configuration, a file it cannot read), then fix what it reports.";

// What a session already told how to act reads at its next send-backs: what it has in its context is not said again.
const BRIEF = `Gates fail again: act as the first send-back of this session told you, or waive with ${WAIVE_SYNTAX}`;

/** What the engine tells the agent, with the prompt of the repo after it, or in its place. */
function worded(own: string, prompt: Prompt | undefined, between: string): string {
  if (prompt === undefined) return own;
  return prompt.replace ? prompt.text : `${own}${between}${prompt.text}`;
}

// The report less the lines the gate omits, or whole when it would omit them all: a red gate always says something.
function sent(report: string, omitLines: string | undefined): string {
  if (omitLines === undefined) return report;
  const omitted = new RegExp(omitLines);
  const kept = report.split("\n").filter((line) => !omitted.test(line));
  return kept.some((line) => line.trim()) ? kept.join("\n") : report;
}

// A helper of the engine counts apart the errors of one source line, with `(2)` after the source it quotes and before
// the tab that ends their key, so that one more of them is new. The agent reads each of them once, with how many
// times it stands. A line of another tool is left as it is.
const COUNTED_APART = /` \(\d+\)\t/;

function saidOnce(report: string): string {
  if (!COUNTED_APART.test(report)) return report;
  const lines = report.split("\n");
  const keyed = lines.map((line) => line.replace(COUNTED_APART, "`\t"));
  const counted = new Set(keyed.filter((line, at) => line !== lines[at]));
  const times = new Map<string, number>();
  for (const line of keyed) if (counted.has(line)) times.set(line, (times.get(line) ?? 0) + 1);
  const said = new Set<string>();
  return keyed
    .filter((line) => !times.has(line) || (!said.has(line) && said.add(line)))
    .map((line) => ((times.get(line) ?? 1) > 1 ? `${line} (×${times.get(line)})` : line))
    .join("\n");
}

// The characters each report gets of a total: what it needs when all fit, else the short ones whole and the rest of
// the total in equal shares for the long ones.
function shares(needs: number[], total: number): number[] {
  const given = [...needs];
  let left = total;
  const shortestFirst = needs.map((_, at) => at).sort((a, b) => (needs[a] ?? 0) - (needs[b] ?? 0));
  shortestFirst.forEach((at, done) => {
    given[at] = Math.min(needs[at] ?? 0, Math.floor(left / (needs.length - done)));
    left -= given[at];
  });
  return given;
}

/** What the owner sees when the gates of the repo miss tools on this machine, as the agent is asked to install them. */
export function toolsMissing(missing: string[]): string {
  const gates = missing.length === 1 ? "1 gate is off" : `${missing.length} gates are off`;
  const lines = missing.map((tool) => paint("dim", `- ${tool}`));
  return [`${paint("fail", LABEL)}  ${gates}, a tool is missing: the agent is asked to install it`, ...lines].join(
    "\n",
  );
}

/** What the agent is told when the gates of the repo miss tools: install them, or the gates that need them stay off. */
export function toolsToInstall(missing: string[], prompt?: Prompt): string {
  const install = [
    "Install these tools first. If they cannot be installed, or the developer refuses, say so and go on with the",
    "prompt: the gates that need them stay off until they are installed, and every other gate still runs.",
  ].join("\n");
  return [
    "Some gates of this repo cannot run on this machine, for a missing tool:",
    ...missing.map((tool) => `- ${tool}`),
    worded(install, prompt, "\n"),
  ].join("\n");
}

/**
 * The report of each failed gate, under its name, how to act on one the turn broke, and the prompt of the repo for it:
 * less the lines the gate omits, each line a helper counts apart said once, in the characters it has, and in its share of a total when the reports have one.
 */
export function reports({ outcomes, wording = {} }: Pick<CheckedTurn, "outcomes" | "wording">): string[] {
  const { gates = [], prompts, maxTotalReportChars = Infinity } = wording;
  const red = outcomes.filter(failed).map(({ name, output, broken }) => {
    const gate = gates.find((known) => known.name === name);
    const report = saidOnce(sent(output, gate?.omitLines));
    const told = [
      ...(broken ? [worded(BROKEN_GATE, prompts?.brokenGate, "\n")] : []),
      ...(gate?.prompt ? [gate.prompt.text] : []),
    ];
    return { name, told, report, needs: Math.min(report.length, gate?.maxReportChars ?? REPORT_CHARS) };
  });
  const given = shares(
    red.map(({ needs }) => needs),
    maxTotalReportChars,
  );
  return red.map(({ name, told, report }, at) => [`## ${name}`, ...told, excerpt(report, given[at])].join("\n"));
}

/**
 * What the agent gets when it is sent back: how to act on a failure, in the words of the engine or of the repo, how
 * to waive a gate, or one line for both once the session was told, what the stop has to tell it, the note of the check, each failed report.
 */
export function failures(turn: CheckedTurn, told: string[] = [], brief = false): string {
  const head = brief ? [BRIEF] : [worded(SEND_BACK, turn.wording?.prompts?.sendBack, "\n\n"), WAIVE];
  return [...head, ...told, ...(turn.note ? [turn.note] : []), ...reports(turn)].join("\n\n");
}

/** A gate of a check, as a tool reads it: its status says what else it holds. */
type GateResult =
  | { name: string; status: "passed"; durationMs: number }
  | { name: string; status: "failed"; durationMs: number; report: string }
  /** The gate could not run: its report says what stopped it, never what the code does wrong. */
  | { name: string; status: "broken"; durationMs: number; report: string }
  /** Stopped for lack of time, so neither green nor red. */
  | { name: string; status: "timed-out"; durationMs: number }
  /** No file it looks at changed. */
  | { name: string; status: "skipped" };

function gateResult({ name, ok, ms, output, timedOut, broken }: Outcome): GateResult {
  const durationMs = Math.round(ms);
  if (ok) return { name, status: "passed", durationMs };
  if (timedOut) return { name, status: "timed-out", durationMs };
  return { name, status: broken ? "broken" : "failed", durationMs, report: output };
}

/**
 * A check for a tool to read, such as a CI or a script, where the summary is for its owner and the send-back for the
 * agent: whether it passed, each gate with its status and its whole report, and the notes of the check.
 */
export function results({ outcomes, skipped, ms, note }: CheckedTurn) {
  const gates: GateResult[] = [
    ...outcomes.map(gateResult),
    ...skipped.map((name) => ({ name, status: "skipped" as const })),
  ];
  return { ok: !outcomes.some(failed), durationMs: Math.round(ms), gates, notes: note ? note.split("\n") : [] };
}
