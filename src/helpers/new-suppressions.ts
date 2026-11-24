import { readFileSync } from "node:fs";
import { headed } from "../core/run.ts";
import { fileAt } from "../core/snapshot.ts";

// The cheapest green is to silence the rule. This prints the rule suppressions the turn added to the changed files,
// one per line, compared with the file as the turn started: the ones already there are the owner's business.

/** The ways to silence a rule in the languages of the catalog: linters, type checkers, formatters, scanners. */
const SUPPRESSIONS =
  /eslint-disable|stylelint-disable|@ts-(ignore|expect-error|nocheck)|prettier-ignore|biome-ignore|\bnoqa\b|type:\s*ignore|pylint:\s*disable|fmt:\s*(off|skip)|\bnosec\b|\bnolint\b|go:nolint|coverage:\s*ignore|pragma:\s*no cover/;

export interface Suppression {
  line: number;
  text: string;
}

// A suppression from where it starts to the end of its line, without the code before it: a change of that code does
// not make it new.
function suppressionOf(line: string): string | undefined {
  const found = SUPPRESSIONS.exec(line);
  return found ? line.slice(found.index).trim() : undefined;
}

/**
 * The suppressions the file holds now and did not hold as the turn started. Each one of the turn start stands for one
 * of now that says the same, so a second one beside it is new.
 */
export function newSuppressions(before: string | undefined, after: string): Suppression[] {
  const held = new Map<string, number>();
  for (const line of (before ?? "").split("\n")) {
    const suppression = suppressionOf(line);
    if (suppression !== undefined) held.set(suppression, (held.get(suppression) ?? 0) + 1);
  }
  return after.split("\n").flatMap((text, index) => {
    const suppression = suppressionOf(text);
    if (suppression === undefined) return [];
    const left = held.get(suppression) ?? 0;
    if (left === 0) return [{ line: index + 1, text: text.trim() }];
    held.set(suppression, left - 1);
    return [];
  });
}

function main(root: string, turn: string, files: string[]): void {
  const found = files.flatMap((file) =>
    newSuppressions(fileAt(root, turn, file), readFileSync(file, "utf8")).map(
      ({ line, text }) => `${file}:${line}: ${text}`,
    ),
  );
  if (!found.length) return;
  console.log(headed("New rule suppressions: fix the code, never the check.", found));
  process.exitCode = 1;
}

if (import.meta.main) main(process.cwd(), process.argv[2] ?? "HEAD", process.argv.slice(3));
