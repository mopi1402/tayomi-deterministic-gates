import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { commandOf } from "../core/run.ts";

// tsc, with the options it is given, such as strict ones a project turned off, printing its errors so that a gate can
// compare them with the ones of the turn start: one line per error, with its file and none of its line and column, so
// an error a change moves down is not new, and a count after an error its file already has, so one more of it is.
// With --watch, tsc keeps watching, and each compilation prints between a line that starts it and one that ends it.

const STARTS = /Starting (compilation in watch mode|incremental compilation)/;
const ENDS = /Found \d+ errors?\. Watching for file changes/;
const POSITION = /^(.+)\(\d+,\d+\): (error TS\d+: .*)$/;

/** The errors tsc printed, each on one line, as the gate compares them. */
export function typeErrors(printed: string[]): string[] {
  const errors: string[] = [];
  for (const line of printed) {
    if (!line.trim()) continue;
    // The lines under an error explain it.
    if (/^\s/.test(line) && errors.length) errors.push(`${errors.pop()} ${line.trim()}`);
    else errors.push(line.replace(POSITION, "$1: $2"));
  }
  const seen = new Map<string, number>();
  return errors.map((error) => {
    const count = (seen.get(error) ?? 0) + 1;
    seen.set(error, count);
    return count === 1 ? error : `${error} (${count})`;
  });
}

/** What to print for each line of tsc in watch mode: nothing until a compilation ends, then its errors. */
export function watching(): (line: string) => string[] {
  let compiled: string[] = [];
  return (line) => {
    if (STARTS.test(line)) {
      compiled = [];
      return ["Type check started"];
    }
    if (ENDS.test(line)) return [...typeErrors(compiled), "Type check done"];
    compiled.push(line);
    return [];
  };
}

function main(root: string, args: string[]): void {
  const tsc = commandOf(root, "typescript");
  if (tsc.missing) {
    console.log(tsc.missing);
    process.exit(1);
  }
  const watch = args.includes("--watch");
  const options = ["--noEmit", "--pretty", "false", ...(watch ? ["--preserveWatchOutput"] : []), ...args];
  const child = spawn(tsc.file, [...tsc.args, ...options], { stdio: ["ignore", "pipe", "inherit"] });
  const printed: string[] = [];
  const print = watching();
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
    console.log(typeErrors(printed).join("\n"));
  });
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
