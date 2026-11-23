import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import type * as Ts from "typescript";
import { type Command, commandOf } from "../core/run.ts";

// tsc, with the options it is given. A tsconfig that only references others, as the tsconfig.json of an Angular
// project, checks no file, and tsc says nothing of it: the gate would be green without checking anything, so it is
// refused, with the tsconfigs it references.

/** The tsconfig tsc reads: the one of -p or --project, a folder meaning its tsconfig.json, or the one of the root. */
function configOf(root: string, args: string[]): string {
  const at = args.findIndex((arg) => arg === "-p" || arg === "--project");
  const given = at === -1 ? undefined : args[at + 1];
  if (given === undefined) return join(root, "tsconfig.json");
  const path = resolve(root, given);
  return statSync(path, { throwIfNoEntry: false })?.isDirectory() ? join(path, "tsconfig.json") : path;
}

function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : (names[0] ?? "");
}

/** Why tsc, with these options, would check no file, or nothing when it checks some, or will say itself what is wrong. */
export function nothingChecked(root: string, args: string[]): string | undefined {
  let ts: typeof Ts;
  try {
    ts = createRequire(join(root, "package.json"))("typescript") as typeof Ts;
  } catch {
    return undefined;
  }
  const file = configOf(root, args);
  const read = ts.readConfigFile(file, (path) => ts.sys.readFile(path));
  if (read.error !== undefined) return undefined;
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, dirname(file), undefined, file);
  const references = parsed.projectReferences ?? [];
  if (parsed.fileNames.length || !references.length) return undefined;
  const names = references.map((reference) => relative(root, ts.resolveProjectReferencePath(reference)));
  return `${relative(root, file)} checks no file: it only references ${listed(names)}. Add -p and the one to check to the gate's run.`;
}

/** The tsc of the repo, once it is known to check files with these options: otherwise, it says why not and exits. */
export function checkingTsc(root: string, args: string[]): Command {
  const tsc = commandOf(root, "typescript");
  const refused = tsc.missing || nothingChecked(root, args);
  if (refused) {
    console.log(refused);
    process.exit(1);
  }
  return tsc;
}

function main(root: string, args: string[]): void {
  const tsc = checkingTsc(root, args);
  const child = spawn(tsc.file, [...tsc.args, ...args], { stdio: "inherit" });
  child.on("close", (code) => process.exit(code ?? 1));
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
