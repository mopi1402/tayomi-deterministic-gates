import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { type Gate, parseGates } from "../core/config.ts";
import { isRecord, messageOf } from "../core/json.ts";

// The catalog lists the gates worth copying into a repo, one file per technology. It never runs by itself: the engine
// reads only .gates.json, and a developer or an agent copies from here what a repo needs.

export const CATALOG_DIR = join(import.meta.dirname, "..", "..", "catalog");
export const PAGE = join(CATALOG_DIR, "index.html");

export interface Requirement {
  tool: string;
  install: string;
}

export interface Entry {
  id: string;
  description: string;
  requires: Requirement[];
  gate: Gate;
  definition: Record<string, unknown>;
}

export interface Catalog {
  id: string;
  title: string;
  description: string;
  entries: Entry[];
}

function isRequirement(value: unknown): value is Requirement {
  return isRecord(value) && typeof value.tool === "string" && typeof value.install === "string";
}

function parseEntry(catalogId: string, value: unknown, index: number): Entry {
  const definition = isRecord(value) && isRecord(value.gate) ? value.gate : {};
  const id = `${catalogId}/${typeof definition.name === "string" ? definition.name : `#${index + 1}`}`;
  function refuse(problem: string): never {
    throw new Error(`${id}: ${problem}.`);
  }
  if (!isRecord(value)) refuse("an entry is an object");
  const { description, requires } = value;
  if (typeof description !== "string" || !description) refuse("description says what the gate catches");
  if (!Array.isArray(requires) || !requires.every(isRequirement))
    refuse("requires lists the tools to install, as {tool, install}");
  let gate: Gate | undefined;
  try {
    [gate] = parseGates(JSON.stringify({ gates: [definition] }));
  } catch (error) {
    refuse(messageOf(error).replace(/\.$/, ""));
  }
  if (gate === undefined) refuse('a catalog gate has severity "error"');
  return { id, description, requires, gate, definition };
}

export function parseCatalog(id: string, text: string): Catalog {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed) || typeof parsed.title !== "string" || typeof parsed.description !== "string")
    throw new Error(`${id}: a catalog has a title and a description.`);
  if (!Array.isArray(parsed.gates)) throw new Error(`${id}: a catalog lists its gates.`);
  const entries = parsed.gates.map((entry: unknown, index) => parseEntry(id, entry, index));
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) throw new Error(`${entry.id}: twice in the catalog.`);
    seen.add(entry.id);
  }
  return { id, title: parsed.title, description: parsed.description, entries };
}

export function readCatalogs(dir: string): Catalog[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => parseCatalog(basename(file, ".json"), readFileSync(join(dir, file), "utf8")));
}

function escape(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function linked(text: string): string {
  return escape(text).replace(/https:\/\/[^\s,]+/g, (url) => `<a href="${url}">${url}</a>`);
}

function entryHtml(entry: Entry): string {
  const { id, description, requires, gate, definition } = entry;
  const compare = gate.compare === "turn-start" ? "<dt>Fails on</dt><dd>only the output lines the turn added</dd>" : "";
  const tools = requires.map(({ tool, install }) => `<li><code>${escape(tool)}</code>: ${linked(install)}</li>`);
  return `<article id="${escape(id)}">
<h3><code>${escape(id)}</code></h3>
<p>${escape(description)}</p>
<dl>
<dt>Runs</dt><dd><code>${escape(gate.run.join(" "))}</code></dd>
<dt>When the turn changes</dt><dd><code>${escape(gate.files)}</code></dd>
${compare}<dt>Requires</dt><dd><ul>${tools.join("")}</ul></dd>
</dl>
<details><summary>Definition to copy into .gates.json</summary><pre><code>${escape(JSON.stringify(definition, null, 2))}</code></pre></details>
</article>`;
}

function catalogSection({ id, title, description, entries }: Catalog): string {
  return `<section id="${escape(id)}">
<h2>${escape(title)}</h2>
<p>${escape(description)}</p>
${entries.map(entryHtml).join("\n")}
</section>`;
}

const STYLE = `
:root { --bg: #fafaf9; --panel: #ffffff; --text: #1c1917; --muted: #57534e; --line: #e7e5e4; --code: #f5f5f4;
  --link: #1d4ed8; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #1c1917; --panel: #262321; --text: #f5f5f4; --muted: #a8a29e; --line: #3f3a36; --code: #2f2a27;
    --link: #93c5fd; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.55 system-ui, sans-serif; }
main { max-width: 860px; margin: 0 auto; padding: 32px 16px 64px; }
h1 { margin: 0 0 8px; font-size: 1.9rem; }
h2 { margin: 48px 0 4px; font-size: 1.4rem; }
h3 { margin: 0; font-size: 1rem; }
p, dd, li { color: var(--muted); }
a { color: var(--link); }
nav { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
nav a { padding: 4px 12px; border: 1px solid var(--line); border-radius: 999px; text-decoration: none; }
article { margin: 16px 0; padding: 16px; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 12px 0; }
dt { font-weight: 600; }
dd { margin: 0; min-width: 0; }
dd ul { margin: 0; padding-left: 18px; }
code { font: 0.88em/1.4 ui-monospace, monospace; background: var(--code); padding: 1px 5px; border-radius: 4px;
  overflow-wrap: anywhere; }
pre { overflow-x: auto; background: var(--code); padding: 12px; border-radius: 8px; }
pre code { padding: 0; }
summary { cursor: pointer; color: var(--muted); }
@media (max-width: 560px) { dl { grid-template-columns: 1fr; } dd { margin-bottom: 8px; } }
`;

/** The page a developer browses. It is generated from the catalog files, and a test fails when it falls behind them. */
export function catalogHtml(catalogs: Catalog[]): string {
  const nav = catalogs.map(
    ({ id, title, entries }) => `<a href="#${escape(id)}">${escape(title)} (${entries.length})</a>`,
  );
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Gate catalog</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<header>
<h1>Gate catalog</h1>
<p>The gates worth copying into a repo. Nothing here runs by itself: the engine reads only the repo's <code>.gates.json</code>. Copy the definition of a gate there, install what it requires, and adapt its <code>files</code> to the layout of the repo.</p>
<p>Generated from <code>catalog/*.json</code> by <code>pnpm catalog</code>: edit those files, never this page.</p>
<nav>${nav.join("")}</nav>
</header>
${catalogs.map(catalogSection).join("\n")}
</main>
</body>
</html>
`;
}

if (import.meta.main) writeFileSync(PAGE, catalogHtml(readCatalogs(CATALOG_DIR)));
