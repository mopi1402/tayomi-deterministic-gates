import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { isRecord, isStringArray, messageOf } from "./json.ts";
import { repoRoot } from "./snapshot.ts";

const GATES_FILE = ".gates.json";
const LOCAL_GATES_FILE = ".gates.local.json";

// The time the gates of a check have, all together: they start at once, so each one stops at the latest when it ends.
const DEFAULT_MAX_TIMEOUT_SECONDS = 45;
// The times a turn sends the agent back: enough for a fix that breaks another gate, never a loop.
const DEFAULT_MAX_SEND_BACKS = 5;
// The characters of reports a send-back holds, all gates together: what one gate may send alone. The agent fixes
// the first problems, and the next check shows it what is left.
const DEFAULT_MAX_TOTAL_REPORT_CHARS = 4000;
const FIELDS = new Set([
  "name",
  "severity",
  "files",
  "run",
  "compare",
  "ignoreLines",
  "lineKey",
  "timeoutSeconds",
  "watch",
  "prompt",
  "maxReportChars",
  "omitLines",
  "brokenExitCodes",
]);
const WATCH_FIELDS = new Set(["run", "cycleStart", "cycleEnd", "failed", "sync", "frozen"]);

/** In the arguments of a gate: the changed files it looks at, and the commit of the turn start. */
export const FILES = "{files}";
export const TURN = "{turn}";

/**
 * A text of the repo for the agent, where the engine has one of its own: added after it, or in its place.
 */
export interface Prompt {
  text: string;
  replace: boolean;
}

/**
 * What the engine tells the agent that a repo may word again: as it sends it back, as it asks for missing tools, and
 * with the report of a gate the turn broke.
 */
const PROMPTS = ["sendBack", "missingTools", "brokenGate"] as const;
export type Prompts = Partial<Record<(typeof PROMPTS)[number], Prompt>>;

function toPrompt(value: unknown): Prompt | undefined {
  if (typeof value === "string" && value) return { text: value, replace: false };
  if (!isRecord(value) || Object.keys(value).join() !== "replace") return undefined;
  return typeof value.replace === "string" && value.replace ? { text: value.replace, replace: true } : undefined;
}

const PROMPT_SHAPE = 'a text to add to what the agent is told, or {"replace": "a text"} to say it instead';

export interface Gate {
  name: string;
  severity: "error" | "off";
  files: string;
  run: string[];
  compare?: "turn-start";
  ignoreLines?: string;
  /** The part of a line of a compared gate that tells it apart, when the rest may print otherwise from run to run. */
  lineKey?: string;
  timeoutSeconds: number;
  watch?: Watch;
  /** The most characters of its report the agent is sent, when the repo or the gate says: 4000 otherwise. */
  maxReportChars?: number;
  /** The lines of its report the agent is never sent, such as the frames of a stack. They change no verdict. */
  omitLines?: string;
  /** What the agent is told with the report of the gate. Replaced, an engine helper leaves its own line out. */
  prompt?: Prompt;
  /** The exit codes of its command that mean it broke, where any other than 0 means it found a problem. */
  brokenExitCodes?: number[];
}

/**
 * A long-running command a gate keeps between turns, such as a test watch, with the patterns of its output that open
 * a cycle, close one, and mark a failure. The gate's own run stays the one-shot command, for a check of the whole repo.
 */
export interface Watch {
  run: string[];
  cycleStart: string;
  cycleEnd: string;
  /** Absent on a compared gate, which fails on the lines the last cycle added to the one the turn started on. */
  failed?: string;
  /** A file of the repo the watch opens a cycle for each time its date changes, such as the tsconfig it reads. */
  sync: string;
  /** The files the watch lists once as it starts, and never again, such as the specs of ng test. */
  frozen?: string;
}

/** A gate that keeps a watch. */
export type WatchedGate = Gate & { watch: Watch };

export function keepsWatch(gate: Gate): gate is WatchedGate {
  return gate.watch !== undefined;
}

type Entry = Record<string, unknown> & { name: string };

/** A gate that fails on the lines of output the turn added, with the report of the turn start to compare with. */
export function isCompared(gate: Gate): boolean {
  return gate.compare === "turn-start";
}

// The problem of one gate: the gate is left out, never the others.
function refuse(problem: string): never {
  throw new Error(problem);
}

/**
 * What a gates file holds: its gates, and when it says, the most seconds a gate may take, how passes show and the
 * most times a turn sends the agent back.
 */
interface GatesFile {
  entries: Entry[];
  maxTimeoutSeconds?: unknown;
  showAllPasses?: unknown;
  maxSendBacks?: unknown;
  maxReportChars?: unknown;
  maxTotalReportChars?: unknown;
  prompts?: unknown;
}

function fileOf(text: string | undefined, file: string): GatesFile {
  if (text === undefined) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${messageOf(error)}.`);
  }
  const {
    gates = [],
    maxTimeoutSeconds,
    showAllPasses,
    maxSendBacks,
    maxReportChars,
    maxTotalReportChars,
    prompts,
    ...others
  } = isRecord(parsed) ? parsed : { others: true };
  if (!Array.isArray(gates) || Object.keys(others).length)
    throw new Error(
      `${file} holds "gates", a list of gates, "maxTimeoutSeconds", the most seconds a gate may take, ` +
        `"showAllPasses", to name every green gate, "maxSendBacks", the most times a turn sends the agent back, ` +
        `"maxReportChars", the most characters of a report the agent is sent, "maxTotalReportChars", the most of ` +
        `all its reports together, and "prompts", what the agent is told.`,
    );
  const entries = gates.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string") throw new Error(`${file}: every gate has a name.`);
    return { ...entry, name: entry.name };
  });
  return {
    entries,
    ...(maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds }),
    ...(showAllPasses === undefined ? {} : { showAllPasses }),
    ...(maxSendBacks === undefined ? {} : { maxSendBacks }),
    ...(maxReportChars === undefined ? {} : { maxReportChars }),
    ...(maxTotalReportChars === undefined ? {} : { maxTotalReportChars }),
    ...(prompts === undefined ? {} : { prompts }),
  };
}

function maxTotalReportCharsOf(shared: GatesFile, local: GatesFile): number {
  const max = local.maxTotalReportChars ?? shared.maxTotalReportChars ?? DEFAULT_MAX_TOTAL_REPORT_CHARS;
  if (!isReportChars(max)) throw new Error("maxTotalReportChars is a whole number, 1 or more.");
  return max;
}

const REPORT_CHARS_SHAPE = "maxReportChars is a whole number, 1 or more";

function isReportChars(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isExitCodes(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((code) => Number.isInteger(code) && code >= 1 && code <= 255);
}

// Nothing unless a file says: the report then keeps the characters the engine gives every gate.
function maxReportCharsOf(shared: GatesFile, local: GatesFile): number | undefined {
  const max = local.maxReportChars ?? shared.maxReportChars;
  if (max !== undefined && !isReportChars(max)) throw new Error(`${REPORT_CHARS_SHAPE}.`);
  return max;
}

function promptsOf({ prompts = {} }: GatesFile): Prompts {
  const known = PROMPTS.map((key) => `"${key}"`).join(", ");
  if (!isRecord(prompts) || Object.keys(prompts).some((key) => !PROMPTS.some((prompt) => prompt === key)))
    throw new Error(`prompts holds ${known}.`);
  return Object.fromEntries(
    Object.entries(prompts).map(([key, value]) => {
      const prompt = toPrompt(value);
      if (prompt === undefined) throw new Error(`prompts.${key} is ${PROMPT_SHAPE}.`);
      return [key, prompt];
    }),
  );
}

// The local file's own value wins, as for the fields of a gate.
function maxTimeoutOf(shared: GatesFile, local: GatesFile): number {
  const max = local.maxTimeoutSeconds ?? shared.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (typeof max !== "number" || max <= 0) throw new Error("maxTimeoutSeconds is a positive number.");
  return max;
}

// Off by default: the summary names the slowest passes and counts the rest.
function showAllPassesOf(shared: GatesFile, local: GatesFile): boolean {
  const show = local.showAllPasses ?? shared.showAllPasses ?? false;
  if (typeof show !== "boolean") throw new Error("showAllPasses is true or false.");
  return show;
}

// 0 never sends the agent back: the owner only sees the summary.
function maxSendBacksOf(shared: GatesFile, local: GatesFile): number {
  const max = local.maxSendBacks ?? shared.maxSendBacks ?? DEFAULT_MAX_SEND_BACKS;
  if (typeof max !== "number" || !Number.isInteger(max) || max < 0)
    throw new Error("maxSendBacks is a whole number, 0 or more.");
  return max;
}

function isPattern(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}

function toWatch(watch: unknown, compared: boolean): Watch {
  if (!isRecord(watch)) return refuse("watch holds run, cycleStart, cycleEnd, failed and sync");
  const unknown = Object.keys(watch).find((key) => !WATCH_FIELDS.has(key));
  if (unknown !== undefined) refuse(`unknown field watch.${unknown}`);
  const { run, cycleStart, cycleEnd, failed, sync, frozen } = watch;
  if (!isStringArray(run) || !run.length) refuse("watch.run is a non-empty list of strings");
  if (run.some((argument) => argument.includes(FILES) || argument.includes(TURN)))
    refuse(`a watch outlives the turn: its run takes neither ${FILES} nor ${TURN}`);
  const pattern = (field: string, value: unknown): string =>
    isPattern(value) ? value : refuse(`watch.${field} is a regular expression on a line of its output`);
  if (compared && failed !== undefined) refuse("a compared watch fails on the lines its cycle added: no watch.failed");
  if (typeof sync !== "string" || !sync || isAbsolute(sync) || sync.split(/[\\/]/).includes(".."))
    refuse("watch.sync is a file of the repo the watch opens a cycle for when its date changes, such as its tsconfig");
  if (frozen !== undefined && !isPattern(frozen))
    refuse("watch.frozen is a regular expression on the files the watch lists only as it starts");
  return {
    run,
    sync,
    ...(frozen === undefined ? {} : { frozen }),
    cycleStart: pattern("cycleStart", cycleStart),
    cycleEnd: pattern("cycleEnd", cycleEnd),
    ...(compared ? {} : { failed: pattern("failed", failed) }),
  };
}

function toGate(entry: Entry, maxTimeoutSeconds: number, reportChars: number | undefined): Gate {
  const {
    name,
    severity,
    files,
    run,
    compare,
    ignoreLines,
    lineKey,
    watch,
    prompt,
    omitLines,
    brokenExitCodes,
    timeoutSeconds = maxTimeoutSeconds,
    maxReportChars = reportChars,
  } = entry;
  const unknown = Object.keys(entry).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) refuse(`unknown field ${unknown}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) refuse("a name is lowercase words joined by hyphens");
  if (severity !== "error" && severity !== "off")
    refuse('severity is "error" or "off": a warning sends nobody back to fix it');
  if (!isPattern(files)) refuse("files is a regular expression on the repo-relative paths");
  if (!isStringArray(run) || !run.length) refuse("run is a non-empty list of strings");
  if (compare !== undefined && compare !== "turn-start") refuse('compare is "turn-start"');
  if (compare !== undefined && run.includes(FILES))
    refuse(`a compared gate reads the whole project: it takes no ${FILES}`);
  if (ignoreLines !== undefined && !isPattern(ignoreLines)) refuse("ignoreLines is a regular expression");
  if (lineKey !== undefined && !isPattern(lineKey)) refuse("lineKey is a regular expression");
  if (lineKey !== undefined && compare === undefined)
    refuse("lineKey tells apart the lines of a compared gate: it takes compare");
  if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) refuse("timeoutSeconds is a positive number");
  if (maxReportChars !== undefined && !isReportChars(maxReportChars)) refuse(REPORT_CHARS_SHAPE);
  if (omitLines !== undefined && !isPattern(omitLines)) refuse("omitLines is a regular expression");
  if (brokenExitCodes !== undefined && !isExitCodes(brokenExitCodes))
    refuse("brokenExitCodes is a list of exit codes, each a whole number from 1 to 255");
  const told = prompt === undefined ? undefined : (toPrompt(prompt) ?? refuse(`prompt is ${PROMPT_SHAPE}`));
  return {
    name,
    severity,
    files,
    run,
    // A gate may stop sooner than the others, never later.
    timeoutSeconds: Math.min(timeoutSeconds, maxTimeoutSeconds),
    ...(compare === undefined ? {} : { compare }),
    ...(ignoreLines === undefined ? {} : { ignoreLines }),
    ...(lineKey === undefined ? {} : { lineKey }),
    ...(watch === undefined ? {} : { watch: toWatch(watch, compare !== undefined) }),
    ...(told === undefined ? {} : { prompt: told }),
    ...(maxReportChars === undefined ? {} : { maxReportChars }),
    ...(omitLines === undefined ? {} : { omitLines }),
    ...(brokenExitCodes === undefined ? {} : { brokenExitCodes }),
  };
}

/**
 * The gates a check runs, the ones it leaves out for a problem of their own, with why, how passes show, and the most
 * times a turn sends the agent back.
 */
export interface Gates {
  gates: Gate[];
  refused: { name: string; why: string }[];
  showAllPasses: boolean;
  maxSendBacks: number;
  maxTotalReportChars: number;
  prompts: Prompts;
}

/**
 * Reads the shared gates and the developer's own. A local entry named like a shared one changes only the fields it
 * gives, such as {"name": "lint", "severity": "off"}. Any other local entry adds a gate. A gate with a problem of its
 * own is left out, and the others still run: only a file that cannot be read stops them all.
 */
export function readGates(shared: string | undefined, local?: string): Gates {
  const sharedFile = fileOf(shared, GATES_FILE);
  const localFile = fileOf(local, LOCAL_GATES_FILE);
  const max = maxTimeoutOf(sharedFile, localFile);
  const reportChars = maxReportCharsOf(sharedFile, localFile);
  const merged = new Map(sharedFile.entries.map((entry) => [entry.name, entry]));
  for (const entry of localFile.entries) merged.set(entry.name, { ...merged.get(entry.name), ...entry });
  const read: Gates = {
    gates: [],
    refused: [],
    showAllPasses: showAllPassesOf(sharedFile, localFile),
    maxSendBacks: maxSendBacksOf(sharedFile, localFile),
    maxTotalReportChars: maxTotalReportCharsOf(sharedFile, localFile),
    // The local file's own prompt wins, key by key.
    prompts: { ...promptsOf(sharedFile), ...promptsOf(localFile) },
  };
  for (const entry of merged.values()) {
    if (entry.severity === "off") continue;
    try {
      read.gates.push(toGate(entry, max, reportChars));
    } catch (error) {
      read.refused.push({ name: entry.name, why: messageOf(error) });
    }
  }
  return read;
}

/** The gates of the two files, refusing the first gate with a problem, as a catalog does. */
export function parseGates(shared: string | undefined, local?: string): Gate[] {
  const { gates, refused } = readGates(shared, local);
  const [first] = refused;
  if (first !== undefined) throw new Error(`Gate ${first.name}: ${first.why}.`);
  return gates;
}

function readIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The text of the two gates files, each absent when the repo does not have it. */
export interface GatesFiles {
  shared?: string;
  local?: string;
}

export function readGatesFiles(root: string): GatesFiles {
  return { shared: readIfPresent(join(root, GATES_FILE)), local: readIfPresent(join(root, LOCAL_GATES_FILE)) };
}

export function gatesOf({ shared, local }: GatesFiles): Gates {
  return readGates(shared, local);
}

/** The gates files a turn changed, by name: a turn is checked with the gates it started with, whatever it did to them. */
export function changedGatesFiles(before: GatesFiles, after: GatesFiles): string[] {
  return [
    ...(before.shared === after.shared ? [] : [GATES_FILE]),
    ...(before.local === after.local ? [] : [LOCAL_GATES_FILE]),
  ];
}

/** The repo to check from a working directory, or nothing outside git or in a repo with no gates file. */
export function configuredRoot(cwd: string): string | undefined {
  const root = repoRoot(cwd);
  if (root === undefined) return undefined;
  return [GATES_FILE, LOCAL_GATES_FILE].some((file) => existsSync(join(root, file))) ? root : undefined;
}
