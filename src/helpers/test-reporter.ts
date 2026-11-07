import { relative } from "node:path";

// The reporter of the related tests: one trace per distinct failure, with every test it hit, where Node's own
// reporters print the same trace once per test file. A module that does not compile fails every test file that
// imports it, with the same error each time.

interface TestEvent {
  type: string;
  data: {
    name: string;
    nesting: number;
    file?: string;
    message?: string;
    details?: { error?: Error & { failureType?: string; cause?: unknown } };
    counts?: { tests: number; failed: number };
  };
}

// The frames of Node itself, and what it prints around an exception nothing caught.
const NOISE =
  /^(\s+at .*\((node:|<anonymous>)|\s+at node:|node:internal\/|\s+triggerUncaughtException\(|  code: '|\}$|Node\.js v\d)/;

function cleaned(text: string): string {
  const lines = text.split("\n");
  // The caret under triggerUncaughtException, and the blank line after it.
  if (lines[0]?.startsWith("node:internal/")) lines.splice(0, 4);
  const cwd = process.cwd();
  return lines
    .filter((line) => !NOISE.test(line))
    .map((line) => line.split(`file://${cwd}/`).join("").split(`${cwd}/`).join(""))
    .join("\n")
    .trimEnd();
}

function traceOf(error: Error & { cause?: unknown }): string {
  const { cause } = error;
  return cleaned(cause instanceof Error ? (cause.stack ?? cause.message) : String(cause ?? error.message));
}

/** Prints each distinct failure once, with the tests it hit, then the counts. */
export default async function* report(source: AsyncIterable<TestEvent>): AsyncGenerator<string> {
  const stderr = new Map<string, string>();
  const names = new Map<string, string[]>();
  const hits = new Map<string, string[]>();
  let counts = "";
  const hit = (trace: string, label: string) => hits.set(trace, [...(hits.get(trace) ?? []), label]);
  for await (const { type, data } of source) {
    const file = data.file === undefined ? data.name : relative(process.cwd(), data.file);
    if (type === "test:stderr") {
      stderr.set(file, (stderr.get(file) ?? "") + (data.message ?? ""));
    } else if (type === "test:start") {
      const path = names.get(file) ?? [];
      path.length = data.nesting;
      path.push(data.name);
      names.set(file, path);
    } else if (type === "test:fail") {
      const error = data.details?.error;
      if (error === undefined || error.failureType === "subtestsFailed") continue;
      // A file that could not run: its error went to stderr, with nothing in the failure.
      if (data.nesting === 0 && data.name === file && !(error.cause instanceof Error)) {
        hit(cleaned(stderr.get(file) ?? error.message), file);
      } else {
        hit(traceOf(error), `${file}: ${(names.get(file) ?? []).slice(0, data.nesting + 1).join(" > ")}`);
      }
    } else if (type === "test:summary" && data.counts) {
      counts = `${data.counts.tests} tests, ${data.counts.failed} failed`;
    }
  }
  for (const [trace, labels] of hits) yield `✖ ${labels.join(", ")}\n${trace}\n\n`;
  yield `${counts}\n`;
}
