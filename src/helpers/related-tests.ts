import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { listFiles } from "../core/snapshot.ts";

// The node:test tests that a change can break: those that import a changed file, directly or through other files.
// Node has no "related" mode of its own, where Vitest has one.

const EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];
const EXTENSION = `\\.(${EXTENSIONS.map((extension) => extension.slice(1)).join("|")})`;

/** Node's own naming of test files, the TypeScript ones included. */
const NODE_TESTS = new RegExp(
  `(\\.test|[-_]test|^test|/test)${EXTENSION}$|/test/.*${EXTENSION}$|(^|/)test-[^/]*${EXTENSION}$`,
);

/** Fails on a changed file no test reaches, which the related tests alone pass in silence. */
const REQUIRE_TESTS = "--require-tests";

// An import of types only runs nothing: the type check is the gate that covers it.
const SPECIFIERS =
  /(?:^|[\s;])(?:import|export)\b(?!\s+type\b)[^'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;

// A relative specifier, resolved as Node would among the files of the repo, with the TypeScript file an import of
// its .js output names.
function resolveImport(files: Set<string>, from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...(base.endsWith(".js") ? [base.replace(/\.js$/, ".ts")] : []),
    ...(base.endsWith(".mjs") ? [base.replace(/\.mjs$/, ".mts")] : []),
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find((candidate) => files.has(candidate));
}

function importsOf(files: Set<string>, file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(SPECIFIERS)].flatMap(([, named, bare]) => {
    const resolved = resolveImport(files, file, named ?? bare ?? "");
    return resolved === undefined ? [] : [resolved];
  });
}

/**
 * For each test file of the repo, by the given naming, the changed files it imports, directly or not. A changed test
 * file reaches itself.
 */
function reachedBy(root: string, changed: string[], tests: RegExp): Map<string, Set<string>> {
  const files = listFiles(root);
  const known = new Set(files.map((file) => resolve(root, file)));
  const changedByPath = new Map(changed.map((file) => [resolve(root, file), file]));
  const imports = new Map<string, string[]>();
  const walk = (file: string, seen: Set<string>, reached: Set<string>): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const name = changedByPath.get(file);
    if (name !== undefined) reached.add(name);
    if (!imports.has(file)) imports.set(file, importsOf(known, file));
    for (const imported of imports.get(file) ?? []) walk(imported, seen, reached);
  };
  return new Map(
    files
      .filter((file) => tests.test(file))
      .map((file) => {
        const reached = new Set<string>();
        walk(resolve(root, file), new Set(), reached);
        return [file, reached] as const;
      }),
  );
}

// The tests that reach a changed file, in order.
function testsReaching(reached: Map<string, Set<string>>): string[] {
  return [...reached]
    .filter(([, files]) => files.size)
    .map(([test]) => test)
    .sort();
}

/** The test files of the repo, by the given naming, that import one of the changed files, directly or not. */
export function relatedTests(root: string, changed: string[], tests: RegExp): string[] {
  return testsReaching(reachedBy(root, changed, tests));
}

function main(args: string[]): void {
  const option = args.indexOf("--tests");
  const tests = option === -1 ? NODE_TESTS : new RegExp(args[option + 1] ?? "");
  const rest = option === -1 ? args : [...args.slice(0, option), ...args.slice(option + 2)];
  const requireTests = rest.includes(REQUIRE_TESTS);
  const changed = rest.filter((arg) => arg !== REQUIRE_TESTS);
  const reached = reachedBy(process.cwd(), changed, tests);
  const tested = new Set([...reached.values()].flatMap((files) => [...files]));
  const untested = requireTests ? changed.filter((file) => !tested.has(file)) : [];
  for (const file of untested) console.log(`No test reaches ${file}: write one that imports it.`);
  if (untested.length) process.exitCode = 1;
  const related = testsReaching(reached);
  if (!related.length) return;
  // Run as a test runner of its own, even from inside another node --test, as the tests of this engine do.
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const reporter = pathToFileURL(join(import.meta.dirname, "test-reporter.ts")).href;
  const run = spawnSync(
    process.execPath,
    ["--test", `--test-reporter=${reporter}`, "--test-reporter-destination=stdout", ...related],
    { stdio: "inherit", env },
  );
  if (run.status !== 0) process.exitCode = run.status ?? 1;
}

if (import.meta.main) main(process.argv.slice(2));
