import { relative } from "node:path";

// A Vitest reporter for a watch: at the end of each run, the state of every spec Vitest has run so far, not only the
// ones it reran. A rerun of one spec then never hides another that is still red: the last run alone tells the state.
// It prints a header line, one FAIL line per failed test with its error under it, then the counts.

interface TestError {
  message?: string;
}

interface TestCase {
  fullName: string;
  result(): { state: string; errors?: readonly TestError[] };
}

interface TestModule {
  moduleId: string;
  errors(): readonly TestError[];
  children: { allTests(): Iterable<TestCase> };
}

/** The header of the state, which the watch helper of the engine looks for. */
export const HEADER = "Spec states:";
export const COUNTS = "Specs:";

function indented(error: TestError): string[] {
  return (error.message ?? "").split("\n").map((line) => `  ${line}`);
}

function failuresOf(module: TestModule): string[] {
  const spec = relative(process.cwd(), module.moduleId);
  const lines = module.errors().flatMap((error) => [`FAIL ${spec}`, ...indented(error)]);
  for (const test of module.children.allTests()) {
    const { state, errors = [] } = test.result();
    if (state === "failed") lines.push(`FAIL ${spec} > ${test.fullName}`, ...errors.flatMap(indented));
  }
  return lines;
}

export default class StateReporter {
  private readonly failures = new Map<string, string[]>();

  onTestRunEnd(modules: readonly TestModule[]): void {
    for (const module of modules) this.failures.set(module.moduleId, failuresOf(module));
    const red = [...this.failures.values()].filter((lines) => lines.length);
    console.log([HEADER, ...red.flat(), `${COUNTS} ${red.length} red of ${this.failures.size}`].join("\n"));
  }
}
