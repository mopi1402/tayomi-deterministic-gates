import { createRequire } from "node:module";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { configOf, nothingChecked } from "./tsc.ts";
import { strictErrorLines } from "./type-errors.ts";

// The Angular compiler of the project, with strict templates and the options it is given forced on top of the
// project's own, printing the errors of its templates so that a gate can compare them with the ones of the turn start.
// It goes through the compiler's API rather than ngc: ngc stops at the errors of the TypeScript, and a strict option
// a project turned off brings many, so it would report no error of a template. Each error prints on the line the
// strict TypeScript errors print on. The errors of the TypeScript are left to them.

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

/** The errors of the templates, each on one line, as the gate compares them. */
export function templateErrors(root: string, diagnostics: readonly Diagnostic[]): string[] {
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

/** The options forced on top of the project's: strict templates, and each --option the gate gives. */
function forced(args: string[]): Record<string, boolean> {
  const options: Record<string, boolean> = { strictTemplates: true };
  for (const arg of args) if (arg.startsWith("--") && arg !== "--project") options[arg.slice(2)] = true;
  return options;
}

/** The Angular compiler of the repo, with the options of the gate: what it says of the templates. */
interface Compiler {
  diagnostics(): Promise<readonly Diagnostic[]>;
}

/**
 * The Angular compiler of the repo, once it is known to check files with the API this helper calls: otherwise, why
 * not. That API is not a public one of Angular, so a version that changed it refuses the gate, never passes it green.
 */
export async function compilerOf(root: string, args: string[]): Promise<{ compiler: Compiler } | { refused: string }> {
  const nothing = nothingChecked(root, args);
  if (nothing) return { refused: nothing };
  const required = createRequire(join(root, "package.json"));
  const ng = await import(pathToFileURL(required.resolve("@angular/compiler-cli")).href);
  const { version } = required("@angular/compiler-cli/package.json") as { version: string };
  const program = ng.NgtscProgram?.prototype;
  const missing = (
    [
      ["NgtscProgram", ng.NgtscProgram],
      ["NgtscProgram.loadNgStructureAsync", program?.loadNgStructureAsync],
      ["NgtscProgram.getNgSemanticDiagnostics", program?.getNgSemanticDiagnostics],
      ["readConfiguration", ng.readConfiguration],
      ["createCompilerHost", ng.createCompilerHost],
    ] as const
  ).find(([, found]) => typeof found !== "function")?.[0];
  if (missing !== undefined)
    return {
      refused: `The API of @angular/compiler-cli ${version} is not the one this gate knows: it has no ${missing}. Update deterministic-gates.`,
    };
  return {
    compiler: {
      async diagnostics() {
        const config = ng.readConfiguration(configOf(root, args));
        const options = { ...config.options, ...forced(args) };
        const program = new ng.NgtscProgram(config.rootNames, options, ng.createCompilerHost({ options }));
        await program.loadNgStructureAsync();
        return program.getNgSemanticDiagnostics();
      },
    },
  };
}

async function main(root: string, args: string[]): Promise<void> {
  const found = await compilerOf(root, args);
  if ("refused" in found) {
    console.log(found.refused);
    process.exit(1);
  }
  console.log(templateErrors(root, await found.compiler.diagnostics()).join("\n"));
}

if (import.meta.main) await main(process.cwd(), process.argv.slice(2));
