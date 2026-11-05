import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Gate } from "./config.ts";
import { isRecord, readJson } from "./json.ts";

// A turn almost always starts from the tree the previous turn ended on, so it reuses the reports of that tree
// instead of running the compared gates again while the prompt waits.

interface Kept {
  run: string[];
  report: string;
}

interface Cache {
  tree: string;
  reports: Record<string, Kept>;
}

function isKept(value: unknown): value is Kept {
  return (
    isRecord(value) &&
    typeof value.report === "string" &&
    Array.isArray(value.run) &&
    value.run.every((arg) => typeof arg === "string")
  );
}

function isCache(value: unknown): value is Cache {
  return (
    isRecord(value) &&
    typeof value.tree === "string" &&
    isRecord(value.reports) &&
    Object.values(value.reports).every(isKept)
  );
}

function cacheFile(root: string): string {
  const repo = createHash("sha256").update(root).digest("hex").slice(0, 16);
  return join(tmpdir(), `gates-reports-${repo}.json`);
}

function readCache(root: string): Cache | undefined {
  try {
    const cache = readJson(readFileSync(cacheFile(root), "utf8"));
    return isCache(cache) ? cache : undefined;
  } catch {
    return undefined;
  }
}

export function cachedReports(root: string, tree: string): (gate: Gate) => string | undefined {
  const cache = readCache(root);
  return (gate) => {
    const kept = cache?.tree === tree ? cache.reports[gate.name] : undefined;
    return kept && JSON.stringify(kept.run) === JSON.stringify(gate.run) ? kept.report : undefined;
  };
}

export function cacheReports(root: string, tree: string, reports: (readonly [Gate, string])[]): void {
  const cache: Cache = {
    tree,
    reports: Object.fromEntries(reports.map(([gate, report]) => [gate.name, { run: gate.run, report }])),
  };
  writeFileSync(cacheFile(root), JSON.stringify(cache));
}
