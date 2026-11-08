import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, isStringArray, messageOf } from "./json.ts";
import { repoRoot } from "./snapshot.ts";

const GATES_FILE = ".gates.json";
const LOCAL_GATES_FILE = ".gates.local.json";

// The time the gates of a check have, all together: they start at once, so each one stops at the latest when it ends.
const DEFAULT_MAX_TIMEOUT_SECONDS = 45;
const FIELDS = new Set(["name", "severity", "files", "run", "compare", "ignoreLines", "timeoutSeconds"]);

/** In the arguments of a gate: the changed files it looks at, and the commit of the turn start. */
export const FILES = "{files}";
export const TURN = "{turn}";

export interface Gate {
  name: string;
  severity: "error" | "off";
  files: string;
  run: string[];
  compare?: "turn-start";
  ignoreLines?: string;
  timeoutSeconds: number;
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

/** What a gates file holds: its gates, and the most seconds a gate of the repo may take, when it says. */
interface GatesFile {
  entries: Entry[];
  maxTimeoutSeconds?: unknown;
}

function fileOf(text: string | undefined, file: string): GatesFile {
  if (text === undefined) return { entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${messageOf(error)}.`);
  }
  const { gates = [], maxTimeoutSeconds, ...others } = isRecord(parsed) ? parsed : { others: true };
  if (!Array.isArray(gates) || Object.keys(others).length)
    throw new Error(
      `${file} holds "gates", a list of gates, and "maxTimeoutSeconds", the most seconds a gate may take.`,
    );
  const entries = gates.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string") throw new Error(`${file}: every gate has a name.`);
    return { ...entry, name: entry.name };
  });
  return { entries, ...(maxTimeoutSeconds === undefined ? {} : { maxTimeoutSeconds }) };
}

// The local file's own value wins, as for the fields of a gate.
function maxTimeoutOf(shared: GatesFile, local: GatesFile): number {
  const max = local.maxTimeoutSeconds ?? shared.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  if (typeof max !== "number" || max <= 0) throw new Error("maxTimeoutSeconds is a positive number.");
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

function toGate(entry: Entry, maxTimeoutSeconds: number): Gate {
  const { name, severity, files, run, compare, ignoreLines, timeoutSeconds = maxTimeoutSeconds } = entry;
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
  if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) refuse("timeoutSeconds is a positive number");
  return {
    name,
    severity,
    files,
    run,
    // A gate may stop sooner than the others, never later.
    timeoutSeconds: Math.min(timeoutSeconds, maxTimeoutSeconds),
    ...(compare === undefined ? {} : { compare }),
    ...(ignoreLines === undefined ? {} : { ignoreLines }),
  };
}

/** The gates a check runs, and the ones it leaves out for a problem of their own, with why. */
export interface Gates {
  gates: Gate[];
  refused: { name: string; why: string }[];
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
  const merged = new Map(sharedFile.entries.map((entry) => [entry.name, entry]));
  for (const entry of localFile.entries) merged.set(entry.name, { ...merged.get(entry.name), ...entry });
  const read: Gates = { gates: [], refused: [] };
  for (const entry of merged.values()) {
    if (entry.severity === "off") continue;
    try {
      read.gates.push(toGate(entry, max));
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
