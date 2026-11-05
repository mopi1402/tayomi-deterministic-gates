import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRecord, readJsonFile } from "../core/json.ts";
import { packageScript } from "../core/run.ts";

// jscpd compared with the tree the turn started from. Its own console report lists every clone of the repo, the old
// ones included, so this prints only the clones the turn added, one per line.

function refuse(): never {
  throw new Error("Not a jscpd report.");
}
function place(value: unknown): string {
  if (!isRecord(value)) refuse();
  const { name, start, end } = value;
  if (typeof name !== "string" || typeof start !== "number" || typeof end !== "number") refuse();
  return `${name}:${start}-${end}`;
}

export function newClones(report: unknown): string[] {
  if (!isRecord(report) || !Array.isArray(report.duplicates)) refuse();
  return report.duplicates.flatMap((clone: unknown) => {
    if (!isRecord(clone)) refuse();
    const line = `${place(clone.firstFile)} ~ ${place(clone.secondFile)}`;
    return clone.isNew === true ? [line] : [];
  });
}

function main(root: string, turn: string): void {
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
      console.log(`jscpd failed: ${said}`);
      process.exitCode = 1;
      return;
    }
    const clones = newClones(readJsonFile(join(output, "jscpd-report.json")));
    if (!clones.length) return;
    console.log(`New clones: factor each one out.\n${clones.join("\n")}`);
    process.exitCode = 1;
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
}

if (import.meta.main) main(process.cwd(), process.argv[2] ?? "HEAD");
