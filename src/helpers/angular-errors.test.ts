import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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

// A compiler with the API the helper knows, which says how many programs it has built: each program reads its root
// files and the template beside each, and says which program it is.
const FAKE_COMPILER = `import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
export const built = [];
export const readConfiguration = (file) => {
  const config = JSON.parse(readFileSync(file, "utf8"));
  const rootNames = config.files.map((name) => join(dirname(file), name));
  return { rootNames, options: config.compilerOptions ?? {}, errors: [] };
};
export const createCompilerHost = ({ options }) => ts.createCompilerHost(options);
export class NgtscProgram {
  constructor(rootNames, options, host) {
    built.push(rootNames);
    this.said = "program " + built.length;
    this.read = () => {
      host.getModifiedResourceFiles();
      for (const root of rootNames) {
        host.getSourceFile(root, 99);
        host.readFile(root.replace(/\\.ts$/, ".html"));
      }
    };
  }
  async loadNgStructureAsync() {
    this.read();
  }
  getTsSyntacticDiagnostics() {
    return [];
  }
  getTsSemanticDiagnostics() {
    return [{ code: 1, messageText: this.said }];
  }
  getNgSemanticDiagnostics() {
    return [];
  }
}
`;

describe("the Angular compiler, checking again a project it has checked", () => {
  const repo = mkdtempSync(join(tmpdir(), "gates-angular-"));
  const package_ = join(repo, "node_modules", "@angular", "compiler-cli");
  const tsconfig = (files: string[], compilerOptions: object = {}) =>
    writeFileSync(join(repo, "tsconfig.json"), JSON.stringify({ files, compilerOptions }));
  // A date of its own for each change: two changes in the same millisecond would read as none.
  let date = Date.now();
  const touch = (file: string) => {
    date += 5000;
    utimesSync(join(repo, file), new Date(date), new Date(date));
  };
  mkdirSync(package_, { recursive: true });
  symlinkSync(
    resolve(import.meta.dirname, "..", "..", "node_modules", "typescript"),
    join(repo, "node_modules", "typescript"),
  );
  writeFileSync(
    join(package_, "package.json"),
    JSON.stringify({
      name: "@angular/compiler-cli",
      version: "99.0.0",
      type: "module",
      exports: { ".": "./index.js", "./package.json": "./package.json" },
    }),
  );
  writeFileSync(join(package_, "index.js"), FAKE_COMPILER);
  for (const file of ["a.ts", "a.html", "b.ts", "b.html"]) writeFileSync(join(repo, file), "");
  after(() => rmSync(repo, { recursive: true, force: true }));

  // The compiler of the repo once it has checked twice, with what a check says and the programs built so far.
  async function checkedTwice() {
    tsconfig(["a.ts", "b.ts"]);
    const { built } = (await import(pathToFileURL(join(package_, "index.js")).href)) as { built: unknown[] };
    const found = await compilerOf(repo, []);
    assert.ok("compiler" in found);
    const check = async () => {
      const [said] = await found.compiler.diagnostics();
      return typeof said?.messageText === "string" ? said.messageText : "";
    };
    await check();
    await check();
    return { check, programs: () => built.length };
  }

  test("checks again at its second check, even when nothing changed: its first check prints otherwise", async () => {
    tsconfig(["a.ts", "b.ts"]);
    const found = await compilerOf(repo, []);
    assert.ok("compiler" in found);
    const [first] = await found.compiler.diagnostics();
    const [second] = await found.compiler.diagnostics();
    assert.notEqual(first?.messageText, second?.messageText);
  });

  test("says what its check before said, without building a program, when no file it read has changed", async () => {
    const { check, programs } = await checkedTwice();
    const said = await check();
    const built = programs();
    assert.equal(await check(), said);
    assert.equal(await check(), said);
    assert.equal(programs(), built);
  });

  test("checks again once a file it read has changed or is gone, or the tsconfig lists other files or options", async () => {
    const { check, programs } = await checkedTwice();
    for (const [what, change] of [
      ["the date of a source", () => touch("a.ts")],
      ["the date of a template", () => touch("b.html")],
      ["the files of the tsconfig", () => tsconfig(["a.ts"])],
      ["the options of the tsconfig", () => tsconfig(["a.ts"], { strict: true })],
      ["a file deleted", () => rmSync(join(repo, "a.html"))],
    ] as const) {
      const before = await check();
      const built = programs();
      change();
      assert.notEqual(await check(), before, what);
      assert.ok(programs() > built, what);
    }
  });
});
