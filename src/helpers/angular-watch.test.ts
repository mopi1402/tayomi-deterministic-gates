import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { replaying } from "./angular-watch.ts";

// What the watch prints for the lines of ng test, in order.
function printed(lines: string[]): string[] {
  const replay = replaying();
  return lines.flatMap(replay);
}

describe("the Angular watch", () => {
  test("prints the lines of ng test as they come", () => {
    const lines = ["Spec states:", "FAIL src/add.spec.ts > add > adds", "Specs: 1 red of 2", "Test run finished"];
    assert.deepEqual(printed(lines), lines);
  });

  test("prints the last state of the specs again before a run that reruns none", () => {
    const said = printed([
      "Spec states:",
      "FAIL src/add.spec.ts > add > adds",
      "Specs: 1 red of 2",
      "[VitestExecutor:Info] Test run finished with success: false.",
      "Changes detected. Rebuilding...",
      "[VitestExecutor:Info] No test specifications to rerun.",
      "[VitestExecutor:Info] Test run finished with success: true.",
    ]);
    assert.deepEqual(said.slice(5), [
      "Spec states:",
      "FAIL src/add.spec.ts > add > adds",
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
