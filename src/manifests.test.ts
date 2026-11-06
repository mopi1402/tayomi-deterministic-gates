import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";

const ROOT = join(import.meta.dirname, "..");

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, file), "utf8"));
}

function versionOf(file: string): unknown {
  const manifest = readJson(file);
  if (file.endsWith("marketplace.json")) return (manifest as { plugins: { version: unknown }[] }).plugins[0]?.version;
  return (manifest as { version: unknown }).version;
}

// The commands of the hooks file, as "${CLAUDE_PLUGIN_ROOT}/<file>" paths.
function hookFiles(): string[] {
  const text = readFileSync(join(ROOT, "hooks/hooks.json"), "utf8");
  return [...text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\\\s]+)/g)].map((match) => match[1] ?? "");
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

  test("name files that exist in the hooks", () => {
    const files = hookFiles();
    assert.ok(files.length > 0, "no ${CLAUDE_PLUGIN_ROOT} path in hooks/hooks.json");
    for (const file of files) assert.ok(existsSync(join(ROOT, file)), `${file} does not exist`);
  });

  test("ship what the hooks and the agents read", () => {
    const shipped = (readJson("package.json") as { files: string[] }).files;
    const needed = [
      ".claude-plugin",
      ".codex-plugin",
      "catalog",
      "hooks",
      ...hookFiles().map((file) => file.split("/")[0]),
    ];
    for (const folder of new Set(needed))
      assert.ok(shipped.includes(folder ?? ""), `${folder} is not in the files of package.json`);
  });
});
