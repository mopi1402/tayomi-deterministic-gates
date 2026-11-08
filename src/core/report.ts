import type { CheckedTurn } from "./check.ts";
import { failed, type Outcome } from "./run.ts";

const LABEL = "● gates";
const SHOWN_PASSES = 6;
const REPORT_CHARS = 4000;
const HEAD_CHARS = 1000;

const TONES = { pass: "1;32", fail: "1;31", late: "1;33", dim: "2" } as const;

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

function nothingChecked({ changed, skipped }: CheckedTurn): string[] {
  if (!changed.length) return [paint("pass", LABEL), `${paint("pass", "✓")} no file changed`];
  const files = changed.length === 1 ? "1 changed file" : `${changed.length} changed files`;
  return [`${paint("pass", LABEL)}  no gate looks at the ${files}`, ...(skipped.length ? [skippedLine(skipped)] : [])];
}

function resultLines({ outcomes, skipped, ms }: CheckedTurn, onFailure: string): string[] {
  const slowest = (a: Outcome, b: Outcome) => b.ms - a.ms;
  const red = outcomes.filter(failed).sort(slowest);
  const late = outcomes.filter((outcome) => outcome.timedOut).sort(slowest);
  const passed = outcomes.filter((outcome) => outcome.ok).sort(slowest);
  const after = red.length && onFailure ? ` · ${onFailure}` : "";
  const outOfTime = late.length ? ` · ${late.length} out of time` : "";
  const notRun = skipped.length ? ` · ${skipped.length} skipped` : "";
  const shown = passed.slice(0, SHOWN_PASSES).map((outcome) => gateLine(paint("pass", "✓"), outcome));
  const rest = passed.length - shown.length;
  const tone = red.length ? "fail" : late.length ? "late" : "pass";
  return [
    `${paint(tone, LABEL)}  ${passed.length}/${outcomes.length} gates green in ${duration(ms)}${outOfTime}${notRun}${after}`,
    ...red.map((outcome) => gateLine(paint("fail", "✗"), outcome)),
    ...late.map((outcome) => gateLine(paint("late", "⏱"), outcome)),
    ...(passed.length ? [[...shown, ...(rest > 0 ? [paint("dim", `... +${rest}`)] : [])].join("  ")] : []),
    ...(skipped.length ? [skippedLine(skipped)] : []),
  ];
}

/**
 * What the owner sees after every check, even when no gate ran, so a silent check never looks dead: one line of
 * totals, with what follows a failure, each failure, the passes slowest first, then the gates the turn did not
 * concern.
 */
export function summary(turn: CheckedTurn, onFailure = ""): string {
  const lines = turn.outcomes.length ? resultLines(turn, onFailure) : nothingChecked(turn);
  return [...lines, ...(turn.note ? [paint("dim", turn.note)] : [])].join("\n");
}

/** What the owner sees when the gates cannot run at all, such as with a gates file that does not parse. */
export function broken(reason: string): string {
  return `${paint("fail", LABEL)}  could not run: ${reason}`;
}

// The cheapest green is to silence the rule, and nothing in the engine judges a report. So the agent is told the one
// way out that is not a cheat: say the report is wrong, and hand back.
const CONDUCT = [
  "Fix the code, never the check: a silenced rule (noqa, eslint-disable, nolint), a weakened gate or an edited",
  ".gates.json does not pass this turn. If a report is wrong, or contradicts what you were asked, say so to the",
  "owner and hand back.",
].join(" ");

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

/** What the agent gets when it is sent back: how to act on a failure, the note of the check, each failed report. */
export function failures({ outcomes, note }: CheckedTurn): string {
  const head = ["Gates fail on what this turn changed. Fix every problem before you hand back.", CONDUCT];
  return [...head, ...(note ? [note] : []), ...reports(outcomes)].join("\n\n");
}
