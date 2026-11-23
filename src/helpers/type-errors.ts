import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { checkingTsc } from "./tsc.ts";

// tsc, with the options it is given, such as strict ones a project turned off, printing its errors so that a gate can
// compare them with the ones of the turn start. tsc prints the same error otherwise from one compilation to the next:
// a watch checks again only the files a change reaches, with types created in another order, so the members of a
// union, the properties of an object, and the file of an error tsc reports once per type, all change. Each error is
// then one line: a key the gate compares, its file, code and source line, so an error a change moves down is not new,
// with a count after one its file already has on the same source, so one more of it is; then, after a tab, the first
// line of its message, for the agent alone.
// With --watch, tsc keeps watching, and each compilation prints between a line that starts it and one that ends it.

const STARTS = /Starting (compilation in watch mode|incremental compilation)/;
const ENDS = /Found \d+ errors?\. Watching for file changes/;
const POSITION = /^(.+)\((\d+),\d+\): error (TS\d+): (.*)$/;
const MESSAGE_CHARS = 300;
const SOURCE_CHARS = 200;

/** The text of a file of the project, or nothing when it cannot be read. */
export type Sources = (file: string) => string | undefined;

function cut(text: string, chars: number): string {
  return text.length > chars ? `${text.slice(0, chars)}…` : text;
}

/** The errors tsc printed, each on one line, as the gate compares them. */
export function typeErrors(printed: string[], sources: Sources): string[] {
  const lines = new Map<string, string[]>();
  const sourceLine = (file: string, line: number) => {
    if (!lines.has(file)) lines.set(file, (sources(file) ?? "").split("\n"));
    return (lines.get(file)?.[line - 1] ?? "").replaceAll("\t", " ").trim();
  };
  const seen = new Map<string, number>();
  const errors: string[] = [];
  for (const line of printed) {
    // The lines under an error explain it, and name its first failing member.
    if (!line.trim() || /^\s/.test(line)) continue;
    const [, file, at, code, message = ""] = POSITION.exec(line) ?? [];
    const found =
      file === undefined ? line : `${file}: error ${code} at \`${cut(sourceLine(file, Number(at)), SOURCE_CHARS)}\``;
    const count = (seen.get(found) ?? 0) + 1;
    seen.set(found, count);
    const key = count === 1 ? found : `${found} (${count})`;
    errors.push(file === undefined ? key : `${key}\t${cut(message, MESSAGE_CHARS)}`);
  }
  return errors;
}

/** What to print for each line of tsc in watch mode: nothing until a compilation ends, then its errors. */
export function watching(sources: Sources): (line: string) => string[] {
  let compiled: string[] = [];
  return (line) => {
    if (STARTS.test(line)) {
      compiled = [];
      return ["Type check started"];
    }
    if (ENDS.test(line)) return [...typeErrors(compiled, sources), "Type check done"];
    compiled.push(line);
    return [];
  };
}

function main(root: string, args: string[]): void {
  const tsc = checkingTsc(root, args);
  const watch = args.includes("--watch");
  const options = ["--noEmit", "--pretty", "false", ...(watch ? ["--preserveWatchOutput"] : []), ...args];
  const child = spawn(tsc.file, [...tsc.args, ...options], { stdio: ["ignore", "pipe", "inherit"] });
  const printed: string[] = [];
  const sources: Sources = (file) => {
    try {
      return readFileSync(resolve(root, file), "utf8");
    } catch {
      return undefined;
    }
  };
  const print = watching(sources);
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (watch) for (const shown of print(line)) console.log(shown);
    else printed.push(line);
  });
  child.on("close", (code) => {
    // 1 and 2 are tsc saying it found errors: the gate counts them, so only a tsc that broke fails.
    if (watch || code === null || code > 2) {
      console.log(printed.join("\n"));
      process.exit(code ?? 1);
    }
    console.log(typeErrors(printed, sources).join("\n"));
  });
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
