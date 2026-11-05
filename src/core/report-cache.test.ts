import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { describe, test } from "node:test";
import type { Gate } from "./config.ts";
import { cachedReports, cacheReports } from "./report-cache.ts";

const KNIP: Gate = {
  name: "dead",
  severity: "error",
  files: "\\.ts$",
  run: ["knip", "--reporter", "compact"],
  compare: "turn-start",
  timeoutSeconds: 30,
};

function repo(): string {
  return `/repo-${randomUUID()}`;
}

describe("the report cache", () => {
  test("gives back the report kept for the same tree", () => {
    const root = repo();
    cacheReports(root, "tree-a", [[KNIP, "a.ts: unused"]]);
    assert.equal(cachedReports(root, "tree-a")(KNIP), "a.ts: unused");
  });

  test("gives nothing for another tree, another repo, or a new command", () => {
    const root = repo();
    cacheReports(root, "tree-a", [[KNIP, "a.ts: unused"]]);
    assert.equal(cachedReports(root, "tree-b")(KNIP), undefined);
    assert.equal(cachedReports(repo(), "tree-a")(KNIP), undefined);
    assert.equal(cachedReports(root, "tree-a")({ ...KNIP, run: ["knip"] }), undefined);
  });

  test("keeps only the latest tree", () => {
    const root = repo();
    cacheReports(root, "tree-a", [[KNIP, "a"]]);
    cacheReports(root, "tree-b", [[KNIP, "b"]]);
    assert.equal(cachedReports(root, "tree-a")(KNIP), undefined);
    assert.equal(cachedReports(root, "tree-b")(KNIP), "b");
  });
});
