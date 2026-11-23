import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gate } from "./config.ts";
import { isRecord, isStringRecord, readJsonFile } from "./json.ts";
import { ENGINE_VERSION } from "./run.ts";

// A turn almost always starts from the tree the previous turn ended on, so it reuses the reports of that tree
// instead of running the compared gates again while the prompt waits. A report is the output of one command on one
// tree, so the reports of a tree are kept by command, whatever the gate is called. A helper of the engine may print
// its report otherwise from one version to the next: the reports of another version are not reused.

interface Cache {
  engine: string;
  tree: string;
  reports: Record<string, string>;
}

function isCache(value: unknown): value is Cache {
  return (
    isRecord(value) &&
    typeof value.engine === "string" &&
    typeof value.tree === "string" &&
    isStringRecord(value.reports)
  );
}

function cacheFile(root: string): string {
  const repo = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(tmpdir(), `gates-reports-${repo}.json`);
}

function commandOf(gate: Gate): string {
  return JSON.stringify(gate.run);
}

function readCache(root: string): Cache | undefined {
  const cache = readJsonFile(cacheFile(root));
  return isCache(cache) && cache.engine === ENGINE_VERSION ? cache : undefined;
}

export function cachedReports(root: string, tree: string): (gate: Gate) => string | undefined {
  const cache = readCache(root);
  return (gate) => (cache?.tree === tree ? cache.reports[commandOf(gate)] : undefined);
}

/** Keeps reports for a tree, with the ones already kept for that tree, and in place of the ones of another tree. */
export function cacheReports(root: string, tree: string, reports: (readonly [Gate, string])[]): void {
  const kept = readCache(root);
  const cache: Cache = {
    engine: ENGINE_VERSION,
    tree,
    reports: {
      ...(kept?.tree === tree ? kept.reports : {}),
      ...Object.fromEntries(reports.map(([gate, report]) => [commandOf(gate), report])),
    },
  };
  writeFileSync(cacheFile(root), JSON.stringify(cache));
}
