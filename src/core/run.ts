import { execFile, type ExecFileException } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { FILES, type Gate, isCompared, TURN } from "./config.ts";
import { isRecord, messageOf, readJsonFile } from "./json.ts";

export interface Outcome {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
  report: string | undefined;
  /** Stopped for lack of time: neither green nor red, since nobody knows what it would have said. */
  timedOut?: boolean;
  /**
   * The gate did not report: its command is missing or broke, its watch stopped. It still fails the turn, since
   * nothing tells a gate the turn broke from one that broke before it, but the agent is told to repair it.
   */
  broken?: boolean;
}

/** A gate that judged the turn and found a problem, or that broke: the only kinds that send the agent back. */
export function failed(outcome: Outcome): boolean {
  return !outcome.ok && !outcome.timedOut;
}

const ENGINE = resolve(import.meta.dirname, "..", "..");
const manifest = readJsonFile(join(ENGINE, "package.json"));
/** The version of this engine: what its helpers print, so what a report holds, may change from one to the next. */
export const ENGINE_VERSION = isRecord(manifest) ? String(manifest.version) : "";
/**
 * What a tool of a repo runs with: no colour, which some tools print anyway, and the commands of its node_modules
 * first on the PATH, as npx and the package managers run them, so that a tool finds the Node the repo pins.
 */
export function toolEnv(root: string): NodeJS.ProcessEnv {
  const path = [join(root, "node_modules", ".bin"), ...(process.env.PATH ? [process.env.PATH] : [])];
  return { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", PATH: path.join(delimiter) };
}

/** The Node a script of the repo or of its packages runs on: the one the repo pins in its node_modules, as npx finds it, or the one of the engine. */
function repoNode(root: string): string {
  const pinned = join(root, "node_modules", ".bin", "node");
  return executable(pinned) ? pinned : process.execPath;
}
/** Set for a gate whose prompt the repo replaces: its command leaves out the line it would tell the agent itself. */
const PROMPT_REPLACED = "GATES_PROMPT_REPLACED";

/** The report of an engine helper: its own line for the agent, unless the repo says another instead, then its list. */
export function headed(own: string, lines: string[], env = process.env): string {
  return [...(env[PROMPT_REPLACED] ? [] : [own]), ...lines].join("\n");
}

const MAX_OUTPUT_MB = 16;
const ENGINE_PREFIX = "{engine}/";

/** A script of this engine: its .ts source, or the .js it is built to when the engine runs from its npm package. */
function engineScript(name: string): string {
  const file = resolve(ENGINE, name);
  return file.endsWith(".ts") && !existsSync(file) ? `${file.slice(0, -".ts".length)}.js` : file;
}

/** How a gate's command starts: the program to execute, the arguments before the gate's own, and why it may be missing. */
export interface Command {
  file: string;
  args: string[];
  missing: string;
}

// A script of the repo runs on the interpreter of its extension.
const INTERPRETERS: [RegExp, (root: string) => string][] = [
  [/\.(ts|js|mjs)$/, repoNode],
  [/\.py$/, () => "python3"],
];

/** The script of a package of the repo's node_modules, or nothing when the repo does not have the package. */
export function packageScript(root: string, name: string): string | undefined {
  const dir = resolve(root, "node_modules", name);
  const manifest = readJsonFile(resolve(dir, "package.json"));
  if (manifest === undefined) return undefined;
  const bin = isRecord(manifest) ? manifest.bin : undefined;
  const commands = isRecord(bin) ? bin : {};
  const script = typeof bin === "string" ? bin : (commands[name] ?? Object.values(commands)[0]);
  if (typeof script !== "string") throw new Error(`${name} has no command.`);
  return resolve(dir, script);
}

/**
 * Resolves the first word of a gate's command, in this order: a script of this engine under {engine}/, a script of the
 * repo by its extension, a package of the repo's node_modules, then a program: by its path in the repo, or by its name
 * on the PATH.
 */
export function commandOf(root: string, name: string): Command {
  if (name.startsWith(ENGINE_PREFIX)) {
    return { file: process.execPath, args: [engineScript(name.slice(ENGINE_PREFIX.length))], missing: "" };
  }
  const interpreter = INTERPRETERS.find(([extension]) => extension.test(name))?.[1](root);
  if (interpreter !== undefined) {
    return {
      file: interpreter,
      args: [resolve(root, name)],
      missing: `${interpreter} is not installed, and ${name} needs it.`,
    };
  }
  const script = packageScript(root, name);
  if (script !== undefined) return { file: repoNode(root), args: [script], missing: "" };
  if (name.includes("/")) return { file: resolve(root, name), args: [], missing: `${name} does not exist.` };
  return {
    file: name,
    args: [],
    missing: `${name} is not installed: it is neither a package of node_modules nor a program on the PATH.`,
  };
}

// A program by its path, or by its name on the PATH, that the system would execute.
function executable(file: string, path = process.env.PATH ?? ""): boolean {
  const candidates = isAbsolute(file) ? [file] : path.split(delimiter).map((dir) => join(dir, file));
  return candidates.some((candidate) => {
    try {
      accessSync(candidate, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

function missingProgram(root: string, name: string): string | undefined {
  let command: Command;
  try {
    command = commandOf(root, name);
  } catch {
    return undefined;
  }
  return command.missing && !executable(command.file, toolEnv(root).PATH) ? command.missing : undefined;
}

/**
 * Why the program of a gate, or of its watch, cannot run on this machine, or nothing when they can: looked up as the
 * gate would start it, without starting it. A command the engine cannot resolve is left to the run, which reports it.
 */
export function missingTool(root: string, gate: Gate): string | undefined {
  return missingProgram(root, gate.run[0] ?? "") ?? (gate.watch && missingProgram(root, gate.watch.run[0] ?? ""));
}

export function argumentsOf(gate: Gate, files: string[], turn: string): string[] {
  return gate.run.slice(1).flatMap((argument) => (argument === FILES ? files : [argument.replaceAll(TURN, turn)]));
}

/** Whether the gate is given the changed files, where another reads the whole project. */
export function givenFiles(gate: Gate): boolean {
  return gate.run.includes(FILES);
}

export function filesOf(gate: Gate, changed: string[]): string[] {
  const pattern = new RegExp(gate.files);
  return changed.filter((file) => pattern.test(file));
}

/**
 * The lines of output a turn added, less the ignored ones. With a key, a line is told by the part the key matches. A
 * line of a new key is still an old one, each line of the turn start whose key went standing for one line only: first
 * when it says the same as such a line, that problem reported elsewhere, unless the group of the key named file names
 * a file the turn changed, where the agent may have written it; then when the first group of the key, its place, is
 * the one of such a line, that problem changed where it is.
 */
export function newLines(
  before: string,
  after: string,
  ignore?: string,
  key?: string,
  changed: string[] = [],
): string[] {
  const ignored = ignore === undefined ? undefined : new RegExp(ignore);
  const keyed = key === undefined ? undefined : new RegExp(key);
  const lines = (text: string) =>
    text
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  const keyOf = (line: string) => keyed?.exec(line)?.[0] ?? line;
  const placeOf = (line: string) => keyed?.exec(line)?.[1];
  const written = (line: string) => changed.includes(keyed?.exec(line)?.groups?.file ?? "");
  const restOf = (line: string) => line.replace(keyOf(line), "").trim();
  const old = lines(before);
  const now = lines(after);
  const oldKeys = new Set(old.map(keyOf));
  const nowKeys = new Set(now.map(keyOf));
  const gone = old.filter((line) => !nowKeys.has(keyOf(line)));
  const stillOld = (same: (was: string) => boolean) => {
    const at = gone.findIndex(same);
    if (at !== -1) gone.splice(at, 1);
    return at !== -1;
  };
  return now
    .filter((line) => !oldKeys.has(keyOf(line)) && !ignored?.test(line))
    .filter((line) => !restOf(line) || written(line) || !stillOld((was) => restOf(was) === restOf(line)))
    .filter((line) => placeOf(line) === undefined || !stillOld((was) => placeOf(was) === placeOf(line)));
}

interface Executed {
  ok: boolean;
  output: string;
  ms: number;
  timedOut: boolean;
  /** The command was never started: it is missing, or the engine cannot resolve it. */
  cannotStart: boolean;
}

async function execute(root: string, gate: Gate, args: string[]): Promise<Executed> {
  const started = performance.now();
  const [name = ""] = gate.run;
  // A gate that cannot start fails alone: the other gates of the turn still report.
  let command: Command;
  try {
    command = commandOf(root, name);
  } catch (error) {
    return {
      ok: false,
      output: messageOf(error),
      ms: performance.now() - started,
      timedOut: false,
      cannotStart: true,
    };
  }
  return new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args, ...args],
      {
        cwd: root,
        timeout: gate.timeoutSeconds * 1000,
        maxBuffer: MAX_OUTPUT_MB * 1024 * 1024,
        env: { ...toolEnv(root), ...(gate.prompt?.replace ? { [PROMPT_REPLACED]: "1" } : {}) },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          output: outputOf(root, gate, command, error, `${stdout}${stderr}`),
          ms: performance.now() - started,
          timedOut: error?.killed === true && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          cannotStart: error?.code === "ENOENT",
        });
      },
    );
  });
}

function outputOf(
  root: string,
  gate: Gate,
  command: Command,
  error: ExecFileException | null,
  printed: string,
): string {
  if (error?.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
    return `Printed more than ${MAX_OUTPUT_MB} MB: too much for the end of a turn. Make it quieter, or move it to CI.`;
  if (error?.killed === true)
    return `Out of time after ${gate.timeoutSeconds} s, so not judged. Make it faster, or move it to CI.`;
  if (error?.code === "ENOENT") return command.missing;
  const said = cleaned(root, printed);
  if (said || !error) return said;
  return `exit code ${String(error.code)}, no output`;
}

/** What a tool printed, for the agent: some tools colour despite NO_COLOR, and absolute paths only cost it tokens. */
export function cleaned(root: string, printed: string): string {
  return stripVTControlCharacters(printed).split(`${root}${sep}`).join("").trim();
}

/**
 * Runs a compared gate on the whole project, as the turn starts, in the time the gate has or less: nothing when it
 * runs out of it, since its lines would all be new at the stop.
 */
export async function wholeProject(
  root: string,
  gate: Gate,
  ms = gate.timeoutSeconds * 1000,
): Promise<{ ok: boolean; output?: string }> {
  const timeoutSeconds = Math.min(gate.timeoutSeconds, ms / 1000);
  const { ok, output, timedOut } = await execute(root, { ...gate, timeoutSeconds }, gate.run.slice(1));
  return timedOut ? { ok: false } : { ok, output };
}

/**
 * Runs a gate on the turn. A compared gate fails on the lines of output the turn added, and is broken on any exit
 * code but 0: the same crash at the start and at the end of a turn prints no new line. A gate out of time is neither.
 */
export async function check(
  root: string,
  gate: Gate,
  files: string[],
  turn: string,
  baseline: string | undefined,
): Promise<Outcome> {
  const { ok, output, ms, timedOut, cannotStart } = await execute(root, gate, argumentsOf(gate, files, turn));
  const ran = { name: gate.name, ms, report: ok ? output : undefined };
  if (timedOut) return { ...ran, ok, output, timedOut };
  // A compared gate exits with 0 when it finds problems: any other code is its command that broke.
  if (!ok && (cannotStart || isCompared(gate))) return { ...ran, ok, output, broken: true };
  if (!isCompared(gate) || !ok) return { ...ran, ok, output };
  return { ...ran, ...addedLines(gate, output, baseline, files) };
}

/**
 * Judges the output of a compared gate that ran clean: it fails on the lines the turn added to the report of the turn
 * start. Without that report, nothing counts but the exit code.
 */
export function addedLines(
  gate: Gate,
  output: string,
  baseline: string | undefined,
  changed: string[],
): { ok: boolean; output: string } {
  if (baseline === undefined) return { ok: true, output: "" };
  const added = newLines(baseline, output, gate.ignoreLines, gate.lineKey, changed);
  return { ok: added.length === 0, output: added.join("\n") };
}
