import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

function versionOf(file: string): unknown {
  const manifest: unknown = JSON.parse(readFileSync(join(ROOT, file), "utf8"));
  if (file.endsWith("marketplace.json")) return (manifest as { plugins: { version: unknown }[] }).plugins[0]?.version;
  return (manifest as { version: unknown }).version;
}

describe("the manifests", () => {
  test("agree on the version: the package, the plugin for each agent, and the marketplace", () => {
    const files = [
      "package.json",
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
    ];
    const versions = new Set(files.map(versionOf));
    assert.equal(versions.size, 1, `versions: ${files.map((file) => `${file} ${String(versionOf(file))}`).join(", ")}`);
  });
});
