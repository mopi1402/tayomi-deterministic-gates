import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { CATALOG_DIR, type Entry, readCatalogs } from "../src/catalog/catalog.ts";
import { handleHook } from "../src/hook/hook.ts";

// Each sample project is checked with the gates of its catalog, by this engine as it is in this folder: the test
// plays the agent, with the events Claude Code and Codex send. A clean change passes every gate, and each gate
// catches the fault written for it. A sample never depends on the engine.

type Edits = Record<string, string>;

interface Fault {
  gate: string;
  what: string;
  edits: Edits;
}

interface Sample {
  clean: Edits;
  faults: Fault[];
}

const ORDER = `export function describeOrder(items: string[], total: number, currency: string): string {
  const lines: string[] = [];
  for (const item of items) {
    lines.push(\`- \${item}\`);
  }
  lines.push(\`Total: \${total.toFixed(2)} \${currency}\`);
  if (items.length === 0) {
    lines.push("No item");
  }
  if (total > 100) {
    lines.push("Free shipping");
  }
  return lines.join("\\n");
}
`;

const SAMPLES: Record<string, Sample> = {
  typescript: {
    clean: {
      "src/add.ts":
        "/** The sum of two numbers. */\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
    },
    faults: [
      { gate: "lint", what: "an unused variable", edits: { "src/unused.ts": "const unused = 1;\n" } },
      {
        gate: "typecheck",
        what: "a string returned as a number",
        edits: { "src/add.ts": 'export function add(a: number, b: number): number {\n  return a + b + "1";\n}\n' },
      },
      {
        gate: "format",
        what: "a file Prettier would rewrite",
        edits: { "src/add.ts": "export function add(a: number, b: number): number {\n  return a+b;\n}\n" },
      },
      {
        gate: "related-tests",
        what: "a change that breaks the test of the file",
        edits: { "src/add.ts": "export function add(a: number, b: number): number {\n  return a - b;\n}\n" },
      },
      {
        gate: "related-node-tests",
        what: "a change that breaks the node:test test of the file",
        edits: { "src/add.ts": "export function add(a: number, b: number): number {\n  return a * b;\n}\n" },
      },
      {
        gate: "no-new-clones",
        what: "a function pasted twice",
        edits: { "src/first.ts": ORDER, "src/second.ts": ORDER },
      },
      {
        gate: "no-new-dead-code",
        what: "an export nothing imports",
        edits: {
          "src/add.ts":
            "export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport function unused(): number {\n  return 0;\n}\n",
        },
      },
      {
        gate: "no-new-suppressions",
        what: "a lint rule silenced",
        edits: {
          "src/add.ts":
            "// eslint-disable-next-line no-unused-vars\nexport function add(a: number, b: number): number {\n  return a + b;\n}\n",
        },
      },
    ],
  },
  go: {
    clean: {
      "sum.go":
        "package main\n\n// Sum adds two integers, left to right.\nfunc Sum(a, b int) int {\n\treturn a + b\n}\n",
    },
    faults: [
      {
        gate: "build",
        what: "an undefined name",
        edits: { "sum.go": "package main\n\nfunc Sum(a, b int) int {\n\treturn a + b + c\n}\n" },
      },
      {
        gate: "vet",
        what: "a string where Printf expects a number",
        edits: { "main.go": 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Printf("%d\\n", "five")\n}\n' },
      },
      {
        gate: "format",
        what: "a file gofmt would rewrite",
        edits: { "sum.go": "package main\n\nfunc Sum(a, b int) int {\n\treturn a+b\n}\n" },
      },
      {
        gate: "test",
        what: "a change that breaks a test",
        edits: { "sum.go": "package main\n\nfunc Sum(a, b int) int {\n\treturn a - b\n}\n" },
      },
      { gate: "lint", what: "a function nothing calls", edits: { "unused.go": "package main\n\nfunc unused() {}\n" } },
      {
        gate: "no-new-suppressions",
        what: "a lint rule silenced",
        edits: { "sum.go": "package main\n\n//nolint:all\nfunc Sum(a, b int) int {\n\treturn a + b\n}\n" },
      },
    ],
  },
  python: {
    clean: {
      "greet.py": 'def greet(name: str) -> str:\n    """Greet someone by name."""\n    return f"Hello, {name}!"\n',
    },
    faults: [
      {
        gate: "lint",
        what: "an unused import",
        edits: { "greet.py": 'import os\n\n\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n' },
      },
      {
        gate: "format",
        what: "a file Ruff would reformat",
        edits: { "greet.py": 'def greet(name:str)->str:\n    return f"Hello, {name}!"\n' },
      },
      {
        gate: "no-new-suppressions",
        what: "a lint rule silenced",
        edits: {
          "greet.py": 'import os  # noqa: F401\n\n\ndef greet(name: str) -> str:\n    return f"Hello, {name}!"\n',
        },
      },
    ],
  },
};

function sampleDir(technology: string): string {
  return join(import.meta.dirname, technology);
}

/** A tool of a gate comes from the sample's node_modules, or from the PATH. */
function installed(technology: string, tool: string): boolean {
  if (existsSync(join(sampleDir(technology), "node_modules", tool))) return true;
  return (process.env.PATH ?? "").split(delimiter).some((dir) => existsSync(join(dir, tool)));
}

function missingTools(technology: string, entry: Entry): string[] {
  return entry.requires.map(({ tool }) => tool).filter((tool) => !installed(technology, tool));
}

/** A copy of the sample as a repo of its own, with the given gates, that the agent works in. */
function project(technology: string, entries: Entry[]) {
  const sample = sampleDir(technology);
  const root = mkdtempSync(join(tmpdir(), `gates-${technology}-`));
  cpSync(sample, root, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  if (existsSync(join(sample, "node_modules"))) symlinkSync(join(sample, "node_modules"), join(root, "node_modules"));
  writeFileSync(join(root, ".gates.json"), JSON.stringify({ gates: entries.map(({ definition }) => definition) }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const session = `integration-${randomUUID()}`;
  const event = (name: string, fields: object) =>
    JSON.stringify({ session_id: session, cwd: root, hook_event_name: name, ...fields });
  return {
    prompt: () => handleHook("turn-start", event("UserPromptSubmit", { prompt: "hi" })),
    edit: (edits: Edits) => {
      for (const [file, text] of Object.entries(edits)) writeFileSync(join(root, file), text);
    },
    stop: () => handleHook("check", event("Stop", { stop_hook_active: false })),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

/** One turn of the agent: prompt, edits, stop. */
async function turn(technology: string, entries: Entry[], edits: Edits) {
  const agent = project(technology, entries);
  try {
    assert.equal(await agent.prompt(), undefined, "the turn starts");
    agent.edit(edits);
    const output = await agent.stop();
    assert.ok(output, "the stop is checked");
    return { ...output, systemMessage: stripVTControlCharacters(output.systemMessage) };
  } finally {
    agent.remove();
  }
}

for (const catalog of readCatalogs(CATALOG_DIR)) {
  const sample = SAMPLES[catalog.id];
  describe(catalog.id, () => {
    test("has a sample project, and a fault for every gate of the catalog", () => {
      assert.ok(sample, `integration/${catalog.id} is missing`);
      assert.deepEqual(
        sample.faults.map(({ gate }) => gate).sort(),
        catalog.entries.map(({ gate }) => gate.name).sort(),
      );
    });
    if (sample === undefined) return;

    const runnable = catalog.entries.filter((entry) => !missingTools(catalog.id, entry).length);

    test("passes every gate on a clean change", { skip: runnable.length ? false : "no tool installed" }, async () => {
      const { decision, systemMessage } = await turn(catalog.id, runnable, sample.clean);
      assert.equal(decision, undefined, systemMessage);
      assert.match(systemMessage, new RegExp(`${runnable.length}/${runnable.length} gates green`));
      assert.doesNotMatch(systemMessage, /not compared|skipped/);
    });

    for (const fault of sample.faults) {
      const entry = catalog.entries.find(({ gate }) => gate.name === fault.gate);
      const missing = entry ? missingTools(catalog.id, entry) : [];
      const skip = entry === undefined || missing.length ? `${missing.join(", ")} not installed` : false;
      test(`${fault.gate} catches ${fault.what}`, { skip }, async () => {
        const { decision, reason, systemMessage } = await turn(catalog.id, runnable, fault.edits);
        assert.equal(decision, "block", systemMessage);
        assert.match(reason ?? "", new RegExp(`^## ${fault.gate}\\n`, "m"));
      });
    }
  });
}
