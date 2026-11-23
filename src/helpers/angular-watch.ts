import { spawn } from "node:child_process";
import { extname, join } from "node:path";
import { createInterface } from "node:readline";
import { commandOf } from "../core/run.ts";
import { COUNTS, HEADER } from "./vitest-state-reporter.ts";

// The watch of an Angular project tested with Vitest: ng test in watch mode, with the reporter of the engine that
// prints the state of every spec at each run, and NG_TEST_LOG, which makes Angular say when a run ends. It prints
// only what judges a run: the build also prints the files it built, a table longer than the report of the specs in a
// large project, whose names change at each build.

const NO_RERUN = /No test specifications to rerun/;
const KEPT = [/Changes detected\. Rebuilding/, /bundle generation failed/, NO_RERUN];
const ENDS = /Test run finished with success/;
// Angular says why a run ended, and says all tests passed of a run with failed specs.
const REASON = /\s*Reason: .*$/;
const ERROR = /^\S+ \[ERROR\] /;
// What a watch that stopped leaves, so that a crash still says why.
const LAST_LINES = 20;

/**
 * What to print for each line of ng test: the lines that open a run, the state of the specs, the errors of a build
 * that failed, with the lines under each, and the line that ends a run, less its reason. A change that leaves the
 * build as it was reruns no spec, so no state prints: the last one is printed again, so that the cycle still tells
 * which specs are red.
 */
export function reporting(): (line: string) => string[] {
  let state: string[] = [];
  let reading: string[] | undefined;
  let inError = false;
  return (line) => {
    if (line === HEADER) reading = [];
    if (reading !== undefined) {
      reading.push(line);
      if (line.startsWith(COUNTS)) {
        state = reading;
        reading = undefined;
      }
      return [line];
    }
    if (ERROR.test(line)) inError = true;
    else if (line.trim() && !/^\s/.test(line)) inError = false;
    if (inError) return [line];
    if (ENDS.test(line)) return [line.replace(REASON, "")];
    if (!KEPT.some((kept) => kept.test(line))) return [];
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
  const report = reporting();
  const last: string[] = [];
  const forward = (line: string) => {
    last.push(line);
    if (last.length > LAST_LINES) last.shift();
    for (const shown of report(line)) console.log(shown);
  };
  createInterface({ input: watch.stdout }).on("line", forward);
  createInterface({ input: watch.stderr }).on("line", forward);
  watch.on("exit", (code) => {
    console.log(["ng test stopped. Its last lines:", ...last].join("\n"));
    process.exit(code ?? 1);
  });
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
