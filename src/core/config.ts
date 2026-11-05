import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, messageOf } from "./json.ts";
import { repoRoot } from "./snapshot.ts";

const GATES_FILE = ".gates.json";
const LOCAL_GATES_FILE = ".gates.local.json";

const DEFAULT_TIMEOUT_SECONDS = 30;
const MAX_TIMEOUT_SECONDS = 60;
const FIELDS = new Set(["name", "severity", "files", "run", "compare", "ignoreLines", "timeoutSeconds"]);

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

function refuse(gate: string, problem: string): never {
  throw new Error(`Gate ${gate}: ${problem}.`);
}

function entriesOf(text: string | undefined, file: string): Entry[] {
  if (text === undefined) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${messageOf(error)}.`);
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.gates) || Object.keys(parsed).some((key) => key !== "gates"))
    throw new Error(`${file} holds one field, "gates": a list of gates.`);
  return parsed.gates.map((entry: unknown) => {
    if (!isRecord(entry) || typeof entry.name !== "string") throw new Error(`${file}: every gate has a name.`);
    return { ...entry, name: entry.name };
  });
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

function toGate(entry: Entry): Gate {
  const { name, severity, files, run, compare, ignoreLines, timeoutSeconds = DEFAULT_TIMEOUT_SECONDS } = entry;
  const unknown = Object.keys(entry).find((key) => !FIELDS.has(key));
  if (unknown !== undefined) refuse(name, `unknown field ${unknown}`);
  if (!/^[a-z][a-z0-9-]*$/.test(name)) refuse(name, "a name is lowercase words joined by hyphens");
  if (severity !== "error" && severity !== "off")
    refuse(name, 'severity is "error" or "off": a warning sends nobody back to fix it');
  if (!isPattern(files)) refuse(name, "files is a regular expression on the repo-relative paths");
  if (!Array.isArray(run) || !run.length || !run.every((arg): arg is string => typeof arg === "string"))
    refuse(name, "run is a non-empty list of strings");
  if (compare !== undefined && compare !== "turn-start") refuse(name, 'compare is "turn-start"');
  if (ignoreLines !== undefined && !isPattern(ignoreLines)) refuse(name, "ignoreLines is a regular expression");
  if (typeof timeoutSeconds !== "number" || timeoutSeconds <= 0) refuse(name, "timeoutSeconds is a positive number");
  if (timeoutSeconds > MAX_TIMEOUT_SECONDS)
    refuse(name, `timeoutSeconds is at most ${MAX_TIMEOUT_SECONDS}: a slower check belongs in CI`);
  return {
    name,
    severity,
    files,
    run,
    timeoutSeconds,
    ...(compare === undefined ? {} : { compare }),
    ...(ignoreLines === undefined ? {} : { ignoreLines }),
  };
}

/**
 * Reads the shared gates and the developer's own. A local entry named like a shared one changes only the fields it
 * gives, such as {"name": "lint", "severity": "off"}. Any other local entry adds a gate.
 */
export function parseGates(shared: string | undefined, local?: string): Gate[] {
  const merged = new Map(entriesOf(shared, GATES_FILE).map((entry) => [entry.name, entry]));
  for (const entry of entriesOf(local, LOCAL_GATES_FILE))
    merged.set(entry.name, { ...merged.get(entry.name), ...entry });
  return [...merged.values()].map(toGate).filter((gate) => gate.severity !== "off");
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
  const shared = readIfPresent(join(root, GATES_FILE));
  const local = readIfPresent(join(root, LOCAL_GATES_FILE));
  return { ...(shared === undefined ? {} : { shared }), ...(local === undefined ? {} : { local }) };
}

export function gatesOf({ shared, local }: GatesFiles): Gate[] {
  return parseGates(shared, local);
}

export function loadGates(root: string): Gate[] {
  return gatesOf(readGatesFiles(root));
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
