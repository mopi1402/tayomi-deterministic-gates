import { execFile, type ExecFileException } from "node:child_process";
import { resolve, sep } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { FILES, type Gate, isCompared, TURN } from "./config.ts";
import { isRecord, messageOf, readJsonFile } from "./json.ts";

export interface Outcome {
  name: string;
  ok: boolean;
  ms: number;
  output: string;
  report: string | undefined;
}

const ENGINE = resolve(import.meta.dirname, "..", "..");
const MAX_OUTPUT_MB = 16;
const ENGINE_PREFIX = "{engine}/";

/** How a gate's command starts: the program to execute, the arguments before the gate's own, and why it may be missing. */
export interface Command {
  file: string;
  args: string[];
  missing: string;
}

// A script of the repo runs on the interpreter of its extension.
const INTERPRETERS: [RegExp, string][] = [
  [/\.(ts|js|mjs)$/, process.execPath],
  [/\.py$/, "python3"],
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
    return { file: process.execPath, args: [resolve(ENGINE, name.slice(ENGINE_PREFIX.length))], missing: "" };
  }
  const interpreter = INTERPRETERS.find(([extension]) => extension.test(name))?.[1];
  if (interpreter !== undefined) {
    return {
      file: interpreter,
      args: [resolve(root, name)],
      missing: `${interpreter} is not installed, and ${name} needs it.`,
    };
  }
  const script = packageScript(root, name);
  if (script !== undefined) return { file: process.execPath, args: [script], missing: "" };
  if (name.includes("/")) return { file: resolve(root, name), args: [], missing: `${name} does not exist.` };
  return {
    file: name,
    args: [],
    missing: `${name} is not installed: it is neither a package of node_modules nor a program on the PATH.`,
  };
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

export function newLines(before: string, after: string, ignore?: string): string[] {
  const ignored = ignore === undefined ? undefined : new RegExp(ignore);
  const seen = new Set(before.split("\n").map((line) => line.trim()));
  return after
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !seen.has(line) && !ignored?.test(line));
}

async function execute(root: string, gate: Gate, args: string[]): Promise<{ ok: boolean; output: string; ms: number }> {
  const started = performance.now();
  const [name = ""] = gate.run;
  // A gate that cannot start fails alone: the other gates of the turn still report.
  let command: Command;
  try {
    command = commandOf(root, name);
  } catch (error) {
    return { ok: false, output: messageOf(error), ms: performance.now() - started };
  }
  return new Promise((resolve) => {
    execFile(
      command.file,
      [...command.args, ...args],
      {
        cwd: root,
        timeout: gate.timeoutSeconds * 1000,
        maxBuffer: MAX_OUTPUT_MB * 1024 * 1024,
        env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          output: outputOf(root, gate, command, error, `${stdout}${stderr}`),
          ms: performance.now() - started,
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
    return `Timed out after ${gate.timeoutSeconds} s: too slow for the end of a turn. Make it faster, or move it to CI.`;
  if (error?.code === "ENOENT") return command.missing;
  // Some tools colour despite NO_COLOR, and absolute paths only cost the agent tokens.
  return stripVTControlCharacters(printed).split(`${root}${sep}`).join("").trim();
}

/** Runs a compared gate on the whole project, as the turn starts. */
export function wholeProject(root: string, gate: Gate): Promise<{ ok: boolean; output: string }> {
  return execute(root, gate, gate.run.slice(1));
}

/**
 * Runs a gate on the turn. A compared gate fails on the lines of output the turn added, and on any exit code but 0:
 * the same crash or timeout at the start and at the end of a turn prints no new line.
 */
export async function check(
  root: string,
  gate: Gate,
  files: string[],
  turn: string,
  baseline: string | undefined,
): Promise<Outcome> {
  const { ok, output, ms } = await execute(root, gate, argumentsOf(gate, files, turn));
  const ran = { name: gate.name, ms, report: ok ? output : undefined };
  if (!isCompared(gate) || !ok) return { ...ran, ok, output };
  if (baseline === undefined) return { ...ran, ok: true, output: "" };
  const added = newLines(baseline, output, gate.ignoreLines);
  return { ...ran, ok: added.length === 0, output: added.join("\n") };
}
