import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { compilerOf, angularErrors } from "./angular-errors.ts";

const ROOT = "/repo";
const CARD = '<h2>{{ title }}</h2>\n<app-badge [count]="title" />\n';

describe("the errors of the Angular compiler", () => {
  test("print an error of a template file on one line: its file, code and source line, then its message", () => {
    const diagnostic = {
      file: { fileName: "/repo/src/app/card.html", text: CARD },
      start: CARD.indexOf("[count]"),
      code: 2322,
      messageText: "Type 'string' is not assignable to type 'number'.",
    };
    assert.deepEqual(angularErrors(ROOT, [diagnostic]), [
      "src/app/card.html: error TS2322 at `<app-badge [count]=\"title\" />`\tType 'string' is not assignable to type 'number'.",
    ]);
  });

  test("print an error of an inline template on the file of its component, at the line of the template", () => {
    const component = "@Component({ template: `\n  <app-badge [count]=\"'x'\" />\n` })\nexport class Inline {}\n";
    const diagnostic = {
      file: { fileName: "/repo/src/app/inline.ts", text: component },
      start: component.indexOf("[count]"),
      code: 2322,
      messageText: "Type 'string' is not assignable to type 'number'.",
    };
    assert.match(
      angularErrors(ROOT, [diagnostic])[0] ?? "",
      /^src\/app\/inline\.ts: error TS2322 at `<app-badge \[count\]="'x'" \/>`\t/,
    );
  });

  test("print a code of Angular's own as Angular prints it", () => {
    const text = "<unknown-thing />\n";
    const diagnostic = {
      file: { fileName: "/repo/src/app/card.html", text },
      start: 0,
      code: -998001,
      messageText: "'unknown-thing' is not a known element:",
    };
    assert.match(
      angularErrors(ROOT, [diagnostic])[0] ?? "",
      /^src\/app\/card\.html: error NG8001 at `<unknown-thing \/>`\t/,
    );
  });

  test("count an error its template already has on the same source line, so that one more of it is new", () => {
    const text = '<app-badge [count]="title" /><app-badge [count]="title" />\n';
    const at = (start: number) => ({
      file: { fileName: "/repo/src/app/card.html", text },
      start,
      code: 2322,
      messageText: "Type 'string' is not assignable to type 'number'.",
    });
    const [first = "", second = ""] = angularErrors(ROOT, [at(11), at(40)]);
    assert.equal(second.split("\t")[0], `${first.split("\t")[0]} (2)`);
  });

  test("keep the first line of a message that explains itself over several", () => {
    const diagnostic = {
      file: { fileName: "/repo/src/app/card.html", text: CARD },
      start: CARD.indexOf("[count]"),
      code: 2322,
      messageText: { messageText: "Type 'string' is not assignable to type 'number'.\n  More on why." },
    };
    assert.match(angularErrors(ROOT, [diagnostic])[0] ?? "", /\tType 'string' is not assignable to type 'number'\.$/);
  });
});

// A project as Angular lays it out, whose compiler is a package of another API than the one the helper knows.
const project = mkdtempSync(join(tmpdir(), "gates-templates-"));
const compiler = join(project, "node_modules", "@angular", "compiler-cli");
mkdirSync(compiler, { recursive: true });
symlinkSync(
  resolve(import.meta.dirname, "..", "..", "node_modules", "typescript"),
  join(project, "node_modules", "typescript"),
);
writeFileSync(
  join(compiler, "package.json"),
  JSON.stringify({
    name: "@angular/compiler-cli",
    version: "99.0.0",
    type: "module",
    exports: { ".": "./index.js", "./package.json": "./package.json" },
  }),
);
writeFileSync(join(compiler, "index.js"), "export const readConfiguration = () => ({});\n");
mkdirSync(join(project, "src"));
writeFileSync(join(project, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(
  join(project, "tsconfig.json"),
  JSON.stringify({ files: [], references: [{ path: "./tsconfig.app.json" }] }),
);
writeFileSync(join(project, "tsconfig.app.json"), JSON.stringify({ include: ["src/**/*.ts"] }));

describe("the Angular compiler, as the strict errors gate runs it", () => {
  after(() => rmSync(project, { recursive: true, force: true }));

  test("refuses a tsconfig that checks no file, since it only references others, and names them", async () => {
    assert.deepEqual(await compilerOf(project, ["--strictNullChecks"]), {
      refused:
        "tsconfig.json checks no file: it only references tsconfig.app.json. Add -p and the one to check to the gate's run.",
    });
  });

  test("refuses an option TypeScript does not know, such as a misspelt one, rather than check nothing more", async () => {
    assert.deepEqual(await compilerOf(project, ["-p", "tsconfig.app.json", "--strictNullCheck"]), {
      refused: "Unknown compiler option '--strictNullCheck'. Did you mean 'strictNullChecks'?",
    });
  });

  test("refuses a compiler whose API is not the one it knows, naming its version, rather than pass green", async () => {
    assert.deepEqual(await compilerOf(project, ["-p", "tsconfig.app.json"]), {
      refused:
        "The API of @angular/compiler-cli 99.0.0 is not the one this gate knows: it has no NgtscProgram. Update deterministic-gates.",
    });
  });
});
