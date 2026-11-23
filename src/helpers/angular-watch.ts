import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { commandOf } from "../core/run.ts";
import { COUNTS, HEADER } from "./vitest-state-reporter.ts";

// The watch of an Angular project tested with Vitest: ng test in watch mode, with the reporter of the engine that
// prints the state of every spec at each run, and NG_TEST_LOG, which makes Angular say when a run ends. A change that
// leaves the build as it was reruns no spec, so no state prints: the last one is printed again, so that the cycle
// still tells which specs are red.

const NO_RERUN = /No test specifications to rerun/;

/**
 * What to print for each line of the watch: the line, and before a run that reruns no spec, the last state of the
 * specs, so that the cycle still tells which specs are red.
 */
export function replaying(): (line: string) => string[] {
  let state: string[] = [];
  let reading: string[] | undefined;
  return (line) => {
    if (line === HEADER) reading = [];
    reading?.push(line);
    if (reading !== undefined && line.startsWith(COUNTS)) {
      state = reading;
      reading = undefined;
    }
    return NO_RERUN.test(line) ? [...state, line] : [line];
  };
}

function main(root: string, args: string[]): void {
  const ng = commandOf(root, "@angular/cli");
  if (ng.missing) {
    console.log(ng.missing);
    process.exit(1);
  }
  const reporter = join(import.meta.dirname, `vitest-state-reporter${extname(import.meta.filename)}`);
  const watch = spawn(ng.file, [...ng.args, "test", "--watch", `--reporters=${reporter}`, ...args], {
    env: { ...process.env, NG_TEST_LOG: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const replay = replaying();
  const forward = (line: string) => console.log(replay(line).join("\n"));
  createInterface({ input: watch.stdout }).on("line", forward);
  createInterface({ input: watch.stderr }).on("line", forward);
  watch.on("exit", (code) => process.exit(code ?? 1));
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
