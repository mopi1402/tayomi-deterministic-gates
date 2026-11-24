import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isRecord, messageOf, parseJson } from "../core/json.ts";
import { headed } from "../core/run.ts";
import { fileAt } from "../core/snapshot.ts";

// ESLint keeps the violations a repo chose to live with in a suppressions file, a count per file and rule, and
// `eslint --suppress-all` writes every violation of now into it: the lint turns green with no comment in the code.
// This prints the counts the turn raised in the suppressions files it changed, compared with the turn start.

/** The count of each rule in each file, as ESLint writes them: { "src/a.ts": { "no-console": { "count": 2 } } }. */
type Counts = Map<string, Map<string, number>>;

function countsOf(file: unknown): Counts {
  const refuse = (): never => {
    throw new Error("Not an ESLint suppressions file.");
  };
  if (!isRecord(file)) return refuse();
  return new Map(
    Object.entries(file).map(([source, rules]) => {
      if (!isRecord(rules)) return refuse();
      const counted = Object.entries(rules).map(([rule, entry]): [string, number] => {
        if (!isRecord(entry) || typeof entry.count !== "number") return refuse();
        return [rule, entry.count];
      });
      return [source, new Map(counted)];
    }),
  );
}

function totals(counts: Counts): Map<string, number> {
  const total = new Map<string, number>();
  for (const rules of counts.values())
    for (const [rule, count] of rules) total.set(rule, (total.get(rule) ?? 0) + count);
  return total;
}

/**
 * The counts that rose, one line per file and rule. A file the turn moved takes its counts to another path: there, a
 * count that rose is new only when the suppressions file holds more of its rule than as the turn started.
 */
export function newBulkSuppressions(
  before: unknown,
  after: unknown,
  moved: (source: string) => boolean = () => false,
): string[] {
  const was = countsOf(before ?? {});
  const now = countsOf(after);
  const [wasTotal, nowTotal] = [totals(was), totals(now)];
  return [...now].flatMap(([source, rules]) =>
    [...rules].flatMap(([rule, count]) => {
      const old = was.get(source)?.get(rule) ?? 0;
      if (count <= old) return [];
      // Asked last: it costs a look at the turn start.
      const cameWithIt = (nowTotal.get(rule) ?? 0) <= (wasTotal.get(rule) ?? 0) && moved(source);
      return cameWithIt ? [] : [`${source}: ${rule} ${old} -> ${count}`];
    }),
  );
}

function main(root: string, turn: string, files: string[]): void {
  const found = files.flatMap((file) => {
    const before = fileAt(root, turn, file);
    // ESLint names a source from the folder it runs in, which holds its suppressions file unless the repo moved it:
    // a source not found there is never taken for a moved one.
    const moved = (source: string) => {
      const path = join(dirname(file), source);
      return existsSync(join(root, path)) && fileAt(root, turn, path) === undefined;
    };
    const rose = newBulkSuppressions(
      before === undefined ? undefined : parseJson(before),
      parseJson(readFileSync(file, "utf8")),
      moved,
    );
    return rose.map((line) => `${file}: ${line}`);
  });
  if (!found.length) return;
  console.log(headed("New bulk suppressions: fix the violations, never the file that hides them.", found));
  process.exitCode = 1;
}

if (import.meta.main) {
  try {
    main(process.cwd(), process.argv[2] ?? "HEAD", process.argv.slice(3));
  } catch (error) {
    // What is wrong with the file, without the stack of this script around it.
    console.log(messageOf(error));
    process.exitCode = 1;
  }
}
