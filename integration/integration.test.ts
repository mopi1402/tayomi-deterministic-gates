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
  /** The project as the session finds it, before any turn. */
  start?: Edits;
  /** A turn before the one with the fault, in the same project, such as for a watch that keeps its state. */
  before?: Edits;
  /** What the report of the gate says, when the header alone could come from another failure. */
  says?: RegExp;
  /** What the report of the gate never says, such as an old problem printed otherwise. */
  saysNot?: RegExp;
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

const TAGS = "export function tags(k: string): string[] | undefined {\n  return k ? undefined : [k];\n}\n";
const SPREAD = (name: string) => `import { tags } from "./tags.ts";\n\nexport const ${name} = [...tags("${name}")];\n`;

const MAYBE = (name: string) => `export const ${name}: string = ["a"].find(Boolean);\n`;

const ADD = (body: string) => `export function add(a: number, b: number): number {\n  return ${body};\n}\n`;

/** A component whose template is a file of its own, which the template lint reads. */
const LOGO = `import { Component } from "@angular/core";

/** The logo of the application. */
@Component({ selector: "app-logo", templateUrl: "./logo.html" })
export class Logo {}
`;

const SAMPLES: Record<string, Sample> = {
  angular: {
    clean: {
      "src/app/add.ts": `/** The sum of two numbers. */\n${ADD("a + b")}`,
      "src/app/logo.ts": LOGO,
      "src/app/logo.html": '<img src="logo.png" alt="The logo" />\n',
    },
    faults: [
      {
        gate: "tests",
        what: "a change that breaks a spec",
        edits: { "src/app/add.ts": ADD("a - b") },
        says: /^FAIL src\/app\/add\.spec\.ts > add > adds two numbers$/m,
      },
      {
        gate: "tests",
        what: "a build that does not compile",
        edits: { "src/app/add.ts": ADD('a + b + "1"') },
        says: /bundle generation failed[^]*TS2322/,
      },
      {
        gate: "tests",
        what: "a spec still red from the turn before, when the change reruns only another one",
        before: { "src/app/add.ts": ADD("a - b") },
        says: /^FAIL src\/app\/add\.spec\.ts > add > adds two numbers$/m,
        edits: {
          "src/app/greet.ts":
            "/** A greeting by name. */\nexport function greet(name: string): string {\n  return `Hello, ${name}!`;\n}\n",
        },
      },
      {
        gate: "build",
        what: "a template that does not compile, in a component no spec imports",
        edits: {
          "src/app/hello.ts": `import { Component, input } from "@angular/core";

/** A greeting, in a template that calls a method a string does not have. */
@Component({ selector: "app-hello", template: "<p>{{ name().toFixed(2) }}</p>" })
export class Hello {
  readonly name = input.required<string>();
}
`,
        },
        says: /^src\/app\/hello\.ts:\d+:\d+:$|TS2551/m,
      },
      {
        gate: "template-lint",
        what: "an image with no text for a screen reader",
        edits: {
          "src/app/logo.ts": LOGO,
          "src/app/logo.html": '<img src="logo.png" />\n',
        },
        says: /template\/alt-text/,
      },
    ],
  },
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
        gate: "no-new-strict-errors",
        what: "a value that may be undefined, which the project lets through with strictNullChecks off",
        edits: {
          "src/first.ts":
            "export function first(items: string[]): string {\n  return items.find((item) => item.length > 0);\n}\n",
        },
        says: /^src\/first\.ts: error TS2322 at `return items\.find\(\(item\) => item\.length > 0\);`\tType 'string \| undefined'/m,
      },
      {
        gate: "no-new-strict-errors",
        what: "a new error in a file others import, and not an old one tsc then reports in another of them",
        // tsc reports an iterated union once per type: in the first file it checks, and a watch checking again the
        // files that import a changed one checks them in another order.
        start: { "src/tags.ts": TAGS, "src/tags-a.ts": SPREAD("a"), "src/tags-b.ts": SPREAD("b") },
        edits: { "src/tags.ts": `${TAGS}\nexport const broken: Set<string> = null;\n` },
        says: /^src\/tags\.ts: error TS2322 at `export const broken: Set<string> = null;`/m,
        saysNot: /TS2488/,
      },
      {
        gate: "no-new-strict-errors",
        what: "a new error that says what an old one the turn fixed in another file said",
        start: { "src/old.ts": MAYBE("old") },
        edits: { "src/old.ts": MAYBE("old").replace(";\n", ' ?? "";\n'), "src/fresh.ts": MAYBE("fresh") },
        says: /^src\/fresh\.ts: error TS2322/m,
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

// A gate whose tool is missing fails its test, with how to install it: a test passed over in silence would let a gate
// of the catalog go untested with every check green.
function assertInstalled(technology: string, entry: Entry): void {
  const missing = entry.requires.filter(({ tool }) => missingTools(technology, entry).includes(tool));
  assert.deepEqual(
    missing.map(({ tool }) => tool),
    [],
    missing.map(({ tool, install }) => `${tool} is not installed: ${install}`).join("\n"),
  );
}

/** A copy of the sample as a repo of its own, with the given gates, that the agent works in. */
function project(technology: string, entries: Entry[], start: Edits = {}) {
  const sample = sampleDir(technology);
  const root = mkdtempSync(join(tmpdir(), `gates-${technology}-`));
  cpSync(sample, root, { recursive: true, filter: (source) => basename(source) !== "node_modules" });
  for (const [file, text] of Object.entries(start)) writeFileSync(join(root, file), text);
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
    // The session ends, which stops the watches it started.
    remove: async () => {
      await handleHook("session-end", event("SessionEnd", { reason: "other" }));
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** One turn of the agent: prompt, edits, stop. Given edits before, a turn with them comes first, in the same project. */
async function turn(technology: string, entries: Entry[], edits: Edits, before?: Edits, start?: Edits) {
  const agent = project(technology, entries, start);
  try {
    if (before !== undefined) {
      await agent.prompt();
      agent.edit(before);
      await agent.stop();
    }
    assert.equal(await agent.prompt(), undefined, "the turn starts");
    agent.edit(edits);
    const output = await agent.stop();
    assert.ok(output, "the stop is checked");
    return { ...output, systemMessage: stripVTControlCharacters(output.systemMessage) };
  } finally {
    await agent.remove();
  }
}

// Each turn plays in a copy of its sample, with watches of its own: the catalogs run side by side, and the turns of
// one two at a time, which keeps the tools of a catalog from crowding the machine. CI runs them one at a time: its
// machines have few cores and cold caches, and no stop waits on it.
const SIDE_BY_SIDE = !process.env.CI;

describe("the catalogs", { concurrency: SIDE_BY_SIDE }, () => {
  for (const catalog of readCatalogs(CATALOG_DIR)) {
    const sample = SAMPLES[catalog.id];
    describe(catalog.id, { concurrency: SIDE_BY_SIDE ? 2 : 1 }, () => {
      test("has a sample project, and a fault for every gate of the catalog", () => {
        assert.ok(sample, `integration/${catalog.id} is missing`);
        assert.deepEqual(
          [...new Set(sample.faults.map(({ gate }) => gate))].sort(),
          catalog.entries.map(({ gate }) => gate.name).sort(),
        );
      });
      if (sample === undefined) return;

      // The gates whose tools are installed: a turn whose gates miss a tool starts by asking for it.
      const runnable = catalog.entries.filter((entry) => !missingTools(catalog.id, entry).length);

      test("passes every gate on a clean change", async () => {
        for (const entry of catalog.entries) assertInstalled(catalog.id, entry);
        const { decision, systemMessage } = await turn(catalog.id, runnable, sample.clean);
        assert.equal(decision, undefined, systemMessage);
        assert.match(systemMessage, new RegExp(`${runnable.length}/${runnable.length} gates green`));
        assert.doesNotMatch(systemMessage, /not compared|skipped/);
      });

      for (const fault of sample.faults) {
        const entry = catalog.entries.find(({ gate }) => gate.name === fault.gate);
        test(`${fault.gate} catches ${fault.what}`, async () => {
          assert.ok(entry, `the catalog has no gate ${fault.gate}`);
          assertInstalled(catalog.id, entry);
          const { decision, reason, systemMessage } = await turn(
            catalog.id,
            runnable,
            fault.edits,
            fault.before,
            fault.start,
          );
          assert.equal(decision, "block", systemMessage);
          assert.match(reason ?? "", new RegExp(`^## ${fault.gate}\\n`, "m"));
          if (fault.says) assert.match(reason ?? "", fault.says);
          if (fault.saysNot) assert.doesNotMatch(reason ?? "", fault.saysNot);
        });
      }
    });
  }
});
