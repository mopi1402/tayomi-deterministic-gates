import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { reporting } from "./angular-watch.ts";

// What the watch prints for the lines of ng test, in order.
function printed(lines: string[]): string[] {
  const report = reporting();
  return lines.flatMap(report);
}

const FIRST_RUN = [
  "[VitestExecutor:Info] VitestExecutor instantiated.",
  "Initial chunk files | Names        | Raw size",
  "chunk-EDDXJTK3.js   | -            |  1.2 MB | ",
  "spec-app-add.js     | spec-app-add | 300 bytes | ",
  "",
  "                    | Initial total |  1.2 MB",
  "Application bundle generation complete. [0.381 seconds] - 2026-11-23T18:20:41.473Z",
  "",
  "Watch mode enabled. Watching for file changes...",
  "[VitestExecutor:Info] Prepared setup files:",
  "[",
  '  "init-testbed.js"',
  "]",
  "Spec states:",
  "FAIL src/add.spec.ts > add > adds",
  "  expected 3 to be 4",
  "Specs: 1 red of 2",
  "[VitestExecutor:Info] Test run finished with success: false. Reason: All tests passed.",
];

const FAILED_BUILD = [
  "❯ Changes detected. Rebuilding...",
  "✔ Changes detected. Rebuilding...",
  "Initial chunk files | Names | Raw size",
  "chunk-APM4PWGG.js   | -     |  1.2 MB | ",
  "Application bundle generation failed. [0.030 seconds] - 2026-11-23T18:20:44.731Z",
  "",
  "✘ [ERROR] TS2322: Type 'string' is not assignable to type 'number'. [plugin angular-compiler]",
  "",
  "    src/app/add.ts:2:2:",
  '      2 │   return a + b + "x";',
  "        ╵   ~~~~~~",
  "",
  "Watch mode enabled. Watching for file changes...",
];

describe("the Angular watch", () => {
  test("prints of a run only what judges it: its state of the specs, and its end without the reason Angular gives", () => {
    assert.deepEqual(printed(FIRST_RUN), [
      "Spec states:",
      "FAIL src/add.spec.ts > add > adds",
      "  expected 3 to be 4",
      "Specs: 1 red of 2",
      "[VitestExecutor:Info] Test run finished with success: false.",
    ]);
  });

  test("prints of a build that failed the line that says so and its errors, never the files it built", () => {
    assert.deepEqual(printed(FAILED_BUILD), [
      "❯ Changes detected. Rebuilding...",
      "✔ Changes detected. Rebuilding...",
      "Application bundle generation failed. [0.030 seconds] - 2026-11-23T18:20:44.731Z",
      "✘ [ERROR] TS2322: Type 'string' is not assignable to type 'number'. [plugin angular-compiler]",
      "",
      "    src/app/add.ts:2:2:",
      '      2 │   return a + b + "x";',
      "        ╵   ~~~~~~",
      "",
    ]);
  });

  test("prints the last state of the specs again before a run that reruns none", () => {
    const said = printed([
      ...FIRST_RUN,
      "❯ Changes detected. Rebuilding...",
      "[VitestExecutor:Info] No test specifications to rerun.",
      "[VitestExecutor:Info] Test run finished with success: true. Reason: All tests passed.",
    ]);
    assert.deepEqual(said.slice(5), [
      "❯ Changes detected. Rebuilding...",
      "Spec states:",
      "FAIL src/add.spec.ts > add > adds",
      "  expected 3 to be 4",
      "Specs: 1 red of 2",
      "[VitestExecutor:Info] No test specifications to rerun.",
      "[VitestExecutor:Info] Test run finished with success: true.",
    ]);
  });

  test("prints nothing more before a run that reruns none, when no state printed yet", () => {
    assert.deepEqual(printed(["[VitestExecutor:Info] No test specifications to rerun."]), [
      "[VitestExecutor:Info] No test specifications to rerun.",
    ]);
  });
});
