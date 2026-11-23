import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, test } from "node:test";
import StateReporter from "./vitest-state-reporter.ts";

// A spec as Vitest hands it to a reporter at the end of a run, with its tests and their errors.
function spec(file: string, tests: Record<string, string | undefined>, errors: string[] = []) {
  return {
    moduleId: join(process.cwd(), file),
    errors: () => errors.map((message) => ({ message })),
    children: {
      allTests: () =>
        Object.entries(tests).map(([fullName, error]) => ({
          fullName,
          result: () => (error === undefined ? { state: "passed" } : { state: "failed", errors: [{ message: error }] }),
        })),
    },
  };
}

// What the reporter prints at the end of each run, one string per run.
function printed(runs: ReturnType<typeof spec>[][]): string[] {
  const reporter = new StateReporter();
  const said: string[] = [];
  const log = console.log;
  console.log = (text: string) => said.push(text);
  try {
    for (const run of runs) reporter.onTestRunEnd(run);
  } finally {
    console.log = log;
  }
  return said;
}

describe("the Vitest state reporter", () => {
  test("prints each failed test with its error, then the counts", () => {
    const [run] = printed([
      [
        spec("src/add.spec.ts", { "add > adds": "expected -1 to be 3", "add > keeps zero": undefined }),
        spec("src/greet.spec.ts", { "greet > greets": undefined }),
      ],
    ]);
    assert.equal(run, "Spec states:\nFAIL src/add.spec.ts > add > adds\n  expected -1 to be 3\nSpecs: 1 red of 2");
  });

  test("keeps a spec red when a later run reruns only another one", () => {
    const red = spec("src/add.spec.ts", { "add > adds": "expected -1 to be 3" });
    const [, second] = printed([
      [red, spec("src/greet.spec.ts", { "greet > greets": undefined })],
      [spec("src/greet.spec.ts", { "greet > greets": undefined })],
    ]);
    assert.match(second ?? "", /^FAIL src\/add\.spec\.ts > add > adds$/m);
    assert.match(second ?? "", /^Specs: 1 red of 2$/m);
  });

  test("turns a spec green once a run passes it again", () => {
    const [, second] = printed([
      [spec("src/add.spec.ts", { "add > adds": "expected -1 to be 3" })],
      [spec("src/add.spec.ts", { "add > adds": undefined })],
    ]);
    assert.equal(second, "Spec states:\nSpecs: 0 red of 1");
  });

  test("fails a spec that does not load, with why", () => {
    const [run] = printed([[spec("src/add.spec.ts", {}, ["Cannot find module './add'"])]]);
    assert.match(run ?? "", /^FAIL src\/add\.spec\.ts\n {2}Cannot find module '\.\/add'$/m);
  });
});
