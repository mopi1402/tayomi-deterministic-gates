import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckedTurn } from "./core/check.ts";
import type { Outcome } from "./core/run.ts";
import { git } from "./core/snapshot.ts";

// What the tests of the engine build again and again: a repo of their own, its commits, its gates, and a turn.

/** A fresh git repo in a temporary folder, for the test to remove. */
export function tempRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "gates-test-"));
  git(repo, ["init", "--quiet"]);
  return repo;
}

/** Commits every file, with an identity git may not have on the machine. */
export function commitAll(repo: string, message: string): void {
  git(repo, ["add", "--all"]);
  git(repo, ["-c", "user.name=test", "-c", "user.email=test@test.invalid", "commit", "--quiet", "-m", message]);
}

export function writeGates(repo: string, ...gates: object[]): void {
  writeFileSync(join(repo, ".gates.json"), JSON.stringify({ gates }));
}

export function outcome(name: string, ok: boolean, ms = 10): Outcome {
  return { name, ok, ms, output: `${name} report`, report: `${name} report` };
}

export function ran(outcomes: Outcome[], skipped: string[] = [], ms = 20): CheckedTurn {
  return { changed: ["src/a.ts"], outcomes, skipped, ms };
}
