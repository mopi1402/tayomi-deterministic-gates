import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, readJsonFile } from "../core/json.ts";
import { headed, packageScript } from "../core/run.ts";
import { filesAt, type WrittenLines, writtenSince } from "../core/snapshot.ts";

// jscpd compared with the tree the turn started from. Its own console report lists every clone of the repo, the old
// ones included, so this prints only the clones the turn added, one per line.
//
// jscpd tells a clone by its two files and where it stands in them, so it also calls new an old clone the turn only
// disturbed: two old files it pairs once the turn takes their copy out of a third, or a clone the turn cut in two by a
// line written in its middle. A clone is the turn's only when the turn wrote in one of its sides.

function refuse(): never {
  throw new Error("Not a jscpd report.");
}

/** A place in a file, as jscpd counts: lines from 1, columns from 0. */
interface Place {
  line: number;
  column: number;
}

/** One of the two sides of a clone: its file, and where it starts and ends, between two tokens. */
interface Side {
  name: string;
  start: Place;
  end: Place;
}

function placeOf(value: unknown, line: number, column: number): Place {
  if (isRecord(value) && typeof value.line === "number" && typeof value.column === "number")
    return { line: value.line, column: value.column };
  return { line, column };
}

// Without the columns of a clone, as from another jscpd, its first and last lines count as whole.
function sideOf(value: unknown): Side {
  if (!isRecord(value)) refuse();
  const { name, start, end, startLoc, endLoc } = value;
  if (typeof name !== "string" || typeof start !== "number" || typeof end !== "number") refuse();
  return { name, start: placeOf(startLoc, start, 0), end: placeOf(endLoc, end, Infinity) };
}

/**
 * Whether the turn wrote in a side of a clone: a line it wrote stands whole in it, or it cut lines out of its middle.
 * A clone starts and ends between two tokens, often inside a line: a line it only starts or ends in is not in it, nor
 * an empty one, which jscpd does not read.
 */
export function wroteIn({ start, end }: Pick<Side, "start" | "end">, text: string, written: WrittenLines[]): boolean {
  const lines = text.split("\n");
  const whole = (at: number) => {
    const line = lines[at - 1] ?? "";
    if (!line.trim()) return false;
    const starts = at > start.line || (at === start.line && start.column <= line.length - line.trimStart().length);
    const ends = at < end.line || (at === end.line && end.column >= line.trimEnd().length);
    return starts && ends;
  };
  return written.some(({ at, lines: count }) =>
    count === 0 ? start.line <= at && at < end.line : Array.from({ length: count }, (_, more) => at + more).some(whole),
  );
}

/** The clones jscpd calls new, each as its two sides. */
function newPairs(report: unknown): Side[][] {
  if (!isRecord(report) || !Array.isArray(report.duplicates)) refuse();
  return report.duplicates.flatMap((clone: unknown) => {
    if (!isRecord(clone)) refuse();
    const sides = [sideOf(clone.firstFile), sideOf(clone.secondFile)];
    return clone.isNew === true ? [sides] : [];
  });
}

/** The clones jscpd calls new, one per line, less the ones the turn wrote in neither side of. */
export function newClones(report: unknown, wrote: (side: Side) => boolean = () => true): string[] {
  return newPairs(report)
    .filter((sides) => sides.some(wrote))
    .map((sides) => sides.map(({ name, start, end }) => `${name}:${start.line}-${end.line}`).join(" ~ "));
}

/**
 * Whether the turn wrote in a side of a clone, for the clones of a report. Each file is read once, however many
 * clones it has: the whole check finds every clone of the repo new.
 */
function turnWrote(root: string, turn: string, report: unknown): (side: Side) => boolean {
  const names = [...new Set(newPairs(report).flatMap((sides) => sides.map(({ name }) => name)))];
  const old = new Set(filesAt(root, turn, names));
  const files = new Map<string, { text: string; written: WrittenLines[] }>();
  return (side) => {
    // A file the turn created is all its own, and one jscpd names from another folder is unknown here: checking too
    // much beats leaving a hole.
    if (!old.has(side.name)) return true;
    try {
      const file = files.get(side.name) ?? {
        text: readFileSync(join(root, side.name), "utf8"),
        written: writtenSince(root, turn, side.name),
      };
      files.set(side.name, file);
      return wroteIn(side, file.text, file.written);
    } catch {
      return true;
    }
  };
}

/** The clones the turn added to the repo, as jscpd finds them. It throws what jscpd said when jscpd fails. */
export function turnClones(root: string, turn: string): string[] {
  const jscpd = packageScript(root, "jscpd");
  if (jscpd === undefined)
    throw new Error("jscpd is not installed in node_modules: install the dependencies of the repo.");
  const output = mkdtempSync(join(tmpdir(), "gates-jscpd-"));
  try {
    try {
      execFileSync(
        process.execPath,
        [jscpd, "--baseline-from-ref", turn, "--reporters", "json,silent", "--output", output],
        { cwd: root, stdio: "pipe" },
      );
    } catch (error) {
      // What jscpd said, without the stack of this script around it.
      const said = isRecord(error) && typeof error.stderr === "string" ? error.stderr.trim() : String(error);
      throw new Error(`jscpd failed: ${said}`, { cause: error });
    }
    const report = readJsonFile(join(output, "jscpd-report.json"));
    return newClones(report, turnWrote(root, turn, report));
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

function main(root: string, turn: string): void {
  let clones: string[];
  try {
    clones = turnClones(root, turn);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("jscpd failed: ")) throw error;
    console.log(error.message);
    process.exitCode = 1;
    return;
  }
  if (!clones.length) return;
  console.log(headed("New clones: reuse the code already there, or factor it out.", clones));
  process.exitCode = 1;
}

if (import.meta.main) main(process.cwd(), process.argv[2] ?? "HEAD");
