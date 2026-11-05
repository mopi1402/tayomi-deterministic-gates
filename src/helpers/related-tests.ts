import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

// The node:test tests that a change can break: those that import a changed file, directly or through other files.
// Node has no "related" mode of its own, where Vitest has one.

/** Node's own naming of test files, the TypeScript ones included. */
const NODE_TESTS =
  /(\.test|[-_]test|^test|\/test)\.(ts|mts|cts|js|mjs|cjs)$|\/test\/.*\.(ts|mts|cts|js|mjs|cjs)$|(^|\/)test-[^/]*\.(ts|mts|cts|js|mjs|cjs)$/;

const SPECIFIERS =
  /(?:^|[\s;])(?:import|export)\b[^'"]*?\bfrom\s*['"]([^'"]+)['"]|(?:^|[\s;])import\s*['"]([^'"]+)['"]/g;

const EXTENSIONS = [".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"];

function files(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
  })
    .split("\0")
    .filter(Boolean);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// A relative specifier, resolved as Node would, with the TypeScript file an import of its .js output names.
function resolveImport(from: string, specifier: string): string | undefined {
  if (!specifier.startsWith(".")) return undefined;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base,
    ...EXTENSIONS.map((extension) => base + extension),
    ...(base.endsWith(".js") ? [base.replace(/\.js$/, ".ts")] : []),
    ...(base.endsWith(".mjs") ? [base.replace(/\.mjs$/, ".mts")] : []),
    ...EXTENSIONS.map((extension) => join(base, `index${extension}`)),
  ];
  return candidates.find(isFile);
}

function importsOf(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(SPECIFIERS)].flatMap(([, named, bare]) => {
    const resolved = resolveImport(file, named ?? bare ?? "");
    return resolved === undefined ? [] : [resolved];
  });
}

/** The test files of the repo, by the given naming, that import one of the changed files, directly or not. */
export function relatedTests(root: string, changed: string[], tests: RegExp): string[] {
  const changedSet = new Set(changed.map((file) => resolve(root, file)));
  const imports = new Map<string, string[]>();
  const reaches = (file: string, seen: Set<string>): boolean => {
    if (changedSet.has(file)) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    if (!imports.has(file)) imports.set(file, importsOf(file));
    return (imports.get(file) ?? []).some((imported) => reaches(imported, seen));
  };
  return files(root)
    .filter((file) => tests.test(file))
    .filter((file) => reaches(resolve(root, file), new Set()))
    .map((file) => relative(root, resolve(root, file)))
    .sort();
}

function main(args: string[]): void {
  const option = args.indexOf("--tests");
  const tests = option === -1 ? NODE_TESTS : new RegExp(args[option + 1] ?? "");
  const changed = option === -1 ? args : [...args.slice(0, option), ...args.slice(option + 2)];
  const related = relatedTests(process.cwd(), changed, tests);
  if (!related.length) return;
  // Run as a test runner of its own, even from inside another node --test, as the tests of this engine do.
  const { NODE_TEST_CONTEXT: _nested, ...env } = process.env;
  const run = spawnSync(process.execPath, ["--test", ...related], { stdio: "inherit", env });
  process.exitCode = run.status ?? 1;
}

if (import.meta.main) main(process.argv.slice(2));
