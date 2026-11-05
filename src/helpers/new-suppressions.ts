import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The cheapest green is to silence the rule. This prints the rule suppressions the turn added to the changed files,
// one per line, compared with the file as the turn started: the ones already there are the owner's business.

/** The ways to silence a rule in the languages of the catalog: linters, type checkers, formatters, scanners. */
const SUPPRESSIONS =
  /eslint-disable|@ts-(ignore|expect-error|nocheck)|prettier-ignore|biome-ignore|\bnoqa\b|type:\s*ignore|pylint:\s*disable|fmt:\s*(off|skip)|\bnosec\b|\bnolint\b|go:nolint|coverage:\s*ignore|pragma:\s*no cover/;

export interface Suppression {
  line: number;
  text: string;
}

/** The suppressions in the lines the file holds now and did not hold as the turn started. */
export function newSuppressions(before: string | undefined, after: string): Suppression[] {
  const seen = new Set((before ?? "").split("\n").map((line) => line.trim()));
  return after.split("\n").flatMap((text, index) => {
    const line = text.trim();
    return line && !seen.has(line) && SUPPRESSIONS.test(line) ? [{ line: index + 1, text: line }] : [];
  });
}

function atTurnStart(root: string, turn: string, file: string): string | undefined {
  try {
    return execFileSync("git", ["show", `${turn}:${file}`], { cwd: root, encoding: "utf8", stdio: "pipe" });
  } catch {
    return undefined;
  }
}

function main(root: string, turn: string, files: string[]): void {
  const found = files.flatMap((file) =>
    newSuppressions(atTurnStart(root, turn, file), readFileSync(file, "utf8")).map(
      ({ line, text }) => `${file}:${line}: ${text}`,
    ),
  );
  if (!found.length) return;
  console.log(`New rule suppressions: fix the code, never the check.\n${found.join("\n")}`);
  process.exitCode = 1;
}

if (import.meta.main) main(process.cwd(), process.argv[2] ?? "HEAD", process.argv.slice(3));
