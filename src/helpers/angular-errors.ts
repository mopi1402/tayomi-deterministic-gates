import { statSync, watchFile } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Ts from "typescript";
import { configOf, nothingChecked } from "./tsc.ts";
import { strictErrorLines } from "./type-errors.ts";

// The Angular compiler of the project, with strict templates and the options it is given forced on top of the
// project's own, printing the errors of its TypeScript and of its templates so that a gate can compare them with the
// ones of the turn start: one program gives both, where tsc reads no template, and a compiler of the templates alone
// would build the same program beside it. It goes through the compiler's API rather than ngc: ngc stops at the errors
// of the TypeScript, and a strict option a project turned off brings many, so it would report no error of a template.
// Each error prints on the line the strict TypeScript errors of tsc print on.
//
// With --watch, it stays, and checks again each time the date of its tsconfig changes, which is how the engine asks
// a watch for a cycle. It follows no other file: a check reads the files as they are when it starts, the ones whose
// date changed since the check before it, so it never misses a change, and it reuses the program of that check. When
// no file that check read has changed, it says what that check said, without checking again.

/** A diagnostic of the Angular compiler, as its API gives it. */
export interface Diagnostic {
  file?: { fileName: string; text: string };
  start?: number;
  code: number;
  messageText: string | { messageText: string };
}

/** A code as Angular prints it: its own codes are negative, -99 then their number, as -998001 for NG8001. */
function codeOf(code: number): string {
  return code < 0 ? `NG${String(-code).slice(2)}` : `TS${code}`;
}

/** The errors of the project, each on one line, as the gate compares them. */
export function angularErrors(root: string, diagnostics: readonly Diagnostic[]): string[] {
  return strictErrorLines(
    diagnostics.map(({ file, start = 0, code, messageText }) => {
      const message = typeof messageText === "string" ? messageText : messageText.messageText;
      if (file === undefined) return message;
      const line = file.text.slice(0, start).split("\n").length - 1;
      return {
        file: relative(root, file.fileName),
        code: codeOf(code),
        source: file.text.split("\n")[line] ?? "",
        message: message.split("\n")[0] ?? "",
      };
    }),
  );
}

/** The arguments that are options of the compiler: not the tsconfig, nor --watch, which are the helper's own. */
function compilerArgs(args: string[]): string[] {
  const own = (arg: string | undefined) => arg === "-p" || arg === "--project";
  return args.filter((arg, at) => arg !== "--watch" && !own(arg) && !own(args[at - 1]));
}

/**
 * The options forced on top of the project's: strict templates, and each option of TypeScript the gate gives, as tsc
 * reads them. One TypeScript does not know is refused, since a misspelt option would otherwise check nothing more and
 * leave the gate green.
 */
function forced(ts: typeof Ts, args: string[]): { options: Ts.CompilerOptions } | { refused: string } {
  const { options, errors, fileNames } = ts.parseCommandLine(compilerArgs(args));
  const [error] = errors;
  if (error !== undefined) return { refused: ts.flattenDiagnosticMessageText(error.messageText, "\n") };
  const [stray] = fileNames;
  if (stray !== undefined) return { refused: `${stray} is not an option of the compiler.` };
  return { options: { strictTemplates: true, ...options } };
}

/** The Angular compiler of the repo, with the options of the gate. */
interface Compiler {
  /** What it says of the project as it is now. Each call reuses what the one before it compiled. */
  diagnostics(): Promise<readonly Diagnostic[]>;
}

function changedAt(file: string): number {
  return statSync(file, { throwIfNoEntry: false })?.mtimeMs ?? 0;
}

/**
 * The Angular compiler of the repo, once it is known to check files with the API this helper calls: otherwise, why
 * not. That API is not a public one of Angular, so a version that changed it refuses the gate, never passes it green.
 */
export async function compilerOf(root: string, args: string[]): Promise<{ compiler: Compiler } | { refused: string }> {
  const nothing = nothingChecked(root, args);
  if (nothing) return { refused: nothing };
  const required = createRequire(join(root, "package.json"));
  const given = forced(required("typescript") as typeof Ts, args);
  if ("refused" in given) return given;
  const ng = await import(pathToFileURL(required.resolve("@angular/compiler-cli")).href);
  const { version } = required("@angular/compiler-cli/package.json") as { version: string };
  const api = ng.NgtscProgram?.prototype;
  const missing = (
    [
      ["NgtscProgram", ng.NgtscProgram],
      ["NgtscProgram.loadNgStructureAsync", api?.loadNgStructureAsync],
      ["NgtscProgram.getTsSyntacticDiagnostics", api?.getTsSyntacticDiagnostics],
      ["NgtscProgram.getTsSemanticDiagnostics", api?.getTsSemanticDiagnostics],
      ["NgtscProgram.getNgSemanticDiagnostics", api?.getNgSemanticDiagnostics],
      ["readConfiguration", ng.readConfiguration],
      ["createCompilerHost", ng.createCompilerHost],
    ] as const
  ).find(([, found]) => typeof found !== "function")?.[0];
  if (missing !== undefined)
    return {
      refused: `The API of @angular/compiler-cli ${version} is not the one this gate knows: it has no ${missing}. Update deterministic-gates.`,
    };

  // What the check before this one read, by the date it had: a file whose date is the same is given as it was, which
  // is how the compiler knows it need not check it again.
  const sources = new Map<string, { at: number; source: unknown }>();
  const resources = new Map<string, number>();
  let last:
    { program: unknown; options: string; roots: string; reused: boolean; checked: readonly Diagnostic[] } | undefined;
  // No file the check before this one read has another date: it would say the same.
  const unchanged = () => {
    for (const [file, { at }] of sources) if (changedAt(file) !== at) return false;
    for (const [file, at] of resources) if (changedAt(file) !== at) return false;
    return true;
  };
  return {
    compiler: {
      async diagnostics() {
        const config = ng.readConfiguration(configOf(root, args));
        const options = { ...config.options, ...given.options };
        // A program checked with other options is no help to this one.
        if (last?.options !== JSON.stringify(options)) {
          last = undefined;
          sources.clear();
          resources.clear();
        }
        // The check before this one stands when nothing it read has changed, which saves checking every file again.
        // Never the first check of a compiler: TypeScript reports some errors once per type, in the first file it
        // checks, and that order is another in a program that reuses one, so a first check served again would be
        // compared with the checks after it, and an error would look new for having moved.
        const roots = JSON.stringify(config.rootNames);
        if (last?.reused && last.roots === roots && unchanged()) return [...config.errors, ...last.checked];
        const base = ng.createCompilerHost({ options });
        const asked = new Set<string>();
        const host = {
          ...base,
          getSourceFile(file: string, ...rest: unknown[]) {
            asked.add(file);
            const at = changedAt(file);
            const kept = sources.get(file);
            if (kept?.at === at) return kept.source;
            const source: unknown = base.getSourceFile(file, ...rest);
            if (source === undefined) sources.delete(file);
            else sources.set(file, { at, source });
            return source;
          },
          // A template or a style, which the compiler reads as text.
          readFile(file: string) {
            if (!/\.(ts|json)$/.test(file) && !resources.has(file)) resources.set(file, changedAt(file));
            return base.readFile(file);
          },
          getModifiedResourceFiles() {
            const modified = new Set<string>();
            for (const [file, at] of resources) {
              const now = changedAt(file);
              if (now === at) continue;
              modified.add(file);
              resources.set(file, now);
            }
            return modified;
          },
        };
        const reused = last !== undefined;
        const program = new ng.NgtscProgram(config.rootNames, options, host, last?.program);
        await program.loadNgStructureAsync();
        const checked: readonly Diagnostic[] = [
          ...program.getTsSyntacticDiagnostics(),
          ...program.getTsSemanticDiagnostics(),
          ...program.getNgSemanticDiagnostics(),
        ];
        // A file the program no longer reads is forgotten once it changes: kept with its old date, it would make
        // every check to come a whole one.
        for (const [file, { at }] of sources) if (!asked.has(file) && changedAt(file) !== at) sources.delete(file);
        last = { program, options: JSON.stringify(options), roots, reused, checked };
        return [...config.errors, ...checked];
      },
    },
  };
}

/** Checks now, then each time the date of the tsconfig changes, saying when a check starts and when it is done. */
async function watch(root: string, args: string[], compiler: Compiler): Promise<void> {
  let asked = false;
  let checking = false;
  const check = async () => {
    asked = true;
    if (checking) return;
    checking = true;
    // Asked again while it checked: the files may have changed since it read them.
    while (asked) {
      asked = false;
      console.log("Type check started");
      console.log([...angularErrors(root, await compiler.diagnostics()), "Type check done"].join("\n"));
    }
    checking = false;
  };
  // Looked at rather than watched: a date read ten times a second misses no change, whatever the file system says.
  watchFile(configOf(root, args), { interval: 100 }, (now, before) => {
    if (now.mtimeMs !== before.mtimeMs) void check();
  });
  await check();
}

async function main(root: string, args: string[]): Promise<void> {
  const found = await compilerOf(root, args);
  if ("refused" in found) {
    console.log(found.refused);
    process.exit(1);
  }
  if (args.includes("--watch")) await watch(root, args, found.compiler);
  else console.log(angularErrors(root, await found.compiler.diagnostics()).join("\n"));
}

if (import.meta.main) await main(process.cwd(), process.argv.slice(2));
