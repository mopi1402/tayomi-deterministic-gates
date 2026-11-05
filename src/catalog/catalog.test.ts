import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { CATALOG_DIR, catalogHtml, PAGE, parseCatalog, readCatalogs } from "./catalog.ts";

const ENTRY = {
  description: "Lints.",
  requires: [{ tool: "ruff", install: "pipx install ruff" }],
  gate: { name: "lint", severity: "error", files: "\\.py$", run: ["ruff", "check", "{files}"] },
};

const catalog = (gates: unknown[]) => JSON.stringify({ title: "Python", description: "Python files.", gates });

describe("the catalog", () => {
  test("ships TypeScript, Go and Python, and every entry is a gate the engine accepts", () => {
    const catalogs = readCatalogs(CATALOG_DIR);
    assert.deepEqual(
      catalogs.map(({ id }) => id),
      ["go", "python", "typescript"],
    );
    assert.ok(catalogs.every(({ entries }) => entries.length > 0));
  });

  test("refuses an entry whose gate the engine would refuse", () => {
    const broken = { ...ENTRY, gate: { ...ENTRY.gate, severity: "warning" } };
    assert.throws(() => parseCatalog("python", catalog([broken])), /python\/lint: Gate lint: severity/);
  });

  test("refuses an entry that does not say what it catches and what it needs", () => {
    const { description: _, ...undescribed } = ENTRY;
    assert.throws(() => parseCatalog("python", catalog([undescribed])), /python\/lint: description/);
    assert.throws(() => parseCatalog("python", catalog([{ ...ENTRY, requires: ["ruff"] }])), /requires/);
  });

  test("names each gate by its technology and its name, and refuses the same name twice", () => {
    assert.equal(parseCatalog("python", catalog([ENTRY])).entries[0]?.id, "python/lint");
    assert.throws(() => parseCatalog("python", catalog([ENTRY, ENTRY])), /python\/lint: twice/);
  });

  test("has a page that matches its files: run pnpm catalog after changing one", () => {
    assert.equal(readFileSync(PAGE, "utf8"), catalogHtml(readCatalogs(CATALOG_DIR)));
  });

  test("escapes what it writes into the page", () => {
    const html = catalogHtml([parseCatalog("python", catalog([{ ...ENTRY, description: "<b>&</b>" }]))]);
    assert.match(html, /&lt;b&gt;&amp;&lt;\/b&gt;/);
    assert.doesNotMatch(html, /<b>&<\/b>/);
  });
});
