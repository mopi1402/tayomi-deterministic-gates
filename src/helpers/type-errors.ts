import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { checkingTsc } from "./tsc.ts";

// tsc, with the options it is given, such as strict ones a project turned off, printing its errors so that a gate can
// compare them with the ones of the turn start: one line per error, with its file and none of its line and column, so
// an error a change moves down is not new, and a count after an error its file already has, so one more of it is.
// tsc orders the members of a union as it happened to create them, which differs between the first compilation of a
// watch and the next ones: each union prints sorted, untruncated, and without the lines under the error, which name its
// first failing member, so the same error always prints the same.
// With --watch, tsc keeps watching, and each compilation prints between a line that starts it and one that ends it.

const STARTS = /Starting (compilation in watch mode|incremental compilation)/;
const ENDS = /Found \d+ errors?\. Watching for file changes/;
const POSITION = /^(.+)\(\d+,\d+\): (error TS\d+: .*)$/;

const OPENS: Record<string, string> = { "(": ")", "[": "]", "{": "}", "<": ">" };
// A property, parameter or index signature before its type, in an object, a tuple or a parameter list.
const LABEL = /^((?:\.\.\.)?(?:[\w$]+|"[^"]*"|\[[^\]]*\])\??: )(.*)$/s;

/** Where the bracket or the string that starts at index ends, or the index itself for any other character. */
function skipped(text: string, index: number): number {
  const char = text[index] ?? "";
  if (char === '"' || char === "`") {
    let end = index + 1;
    while (end < text.length && text[end] !== char) end += text[end] === "\\" ? 2 : 1;
    return end;
  }
  const close = OPENS[char];
  if (close === undefined) return index;
  let end = index + 1;
  // The arrow of a function type closes no bracket.
  while (end < text.length && text[end] !== close) end = text.startsWith("=>", end) ? end + 2 : skipped(text, end) + 1;
  return end;
}

/** The parts of a text between a separator that no bracket nor string encloses. */
function split(text: string, separator: string): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < text.length; index = skipped(text, index) + 1) {
    if (text.startsWith("=>", index)) index++;
    else if (text.startsWith(separator, index)) {
      parts.push(text.slice(start, index));
      start = index + separator.length;
      index += separator.length - 1;
    }
  }
  return [...parts, text.slice(start)];
}

/** A type as tsc prints it, with the members of each union and intersection sorted, at every depth. */
function sortedType(type: string): string {
  // A function type outside any bracket returns all the rest: a union of function types puts each in parentheses.
  const [parameters = "", ...returned] = split(type, " => ");
  if (returned.length) return `${sortedInside(parameters)} => ${sortedType(returned.join(" => "))}`;
  const sorted = (members: string[]) => (members.length > 1 ? members.sort() : members);
  const union = split(type, " | ").map((member) => sorted(split(member, " & ").map(sortedInside)).join(" & "));
  return sorted(union).join(" | ");
}

/** A type with the content of each of its brackets sorted. */
function sortedInside(type: string): string {
  let out = "";
  for (let index = 0; index < type.length;) {
    const end = skipped(type, index);
    const char = type[index] ?? "";
    if (OPENS[char] !== undefined) {
      const separator = char === "{" ? ";" : ",";
      const inner = split(type.slice(index + 1, end), separator).map((element) => {
        const [, before = "", trimmed = "", after = ""] = /^(\s*)(.*?)(\s*)$/s.exec(element) ?? [];
        const label = LABEL.exec(trimmed);
        return before + (label ? `${label[1]}${sortedType(label[2] ?? "")}` : sortedType(trimmed)) + after;
      });
      out += `${char}${inner.join(separator)}${type[end] ?? ""}`;
    } else out += type.slice(index, end + 1);
    index = end + 1;
  }
  return out;
}

/** The errors tsc printed, each on one line, as the gate compares them. */
export function typeErrors(printed: string[]): string[] {
  const errors: string[] = [];
  for (const line of printed) {
    // The lines under an error explain it, and name its first failing member.
    if (!line.trim() || /^\s/.test(line)) continue;
    const located = line.replace(POSITION, "$1: $2");
    // tsc quotes each type it names.
    errors.push(located.replace(/'([^']*)'/g, (_quoted, type: string) => `'${sortedType(type)}'`));
  }
  const seen = new Map<string, number>();
  return errors.map((error) => {
    const count = (seen.get(error) ?? 0) + 1;
    seen.set(error, count);
    return count === 1 ? error : `${error} (${count})`;
  });
}

/** What to print for each line of tsc in watch mode: nothing until a compilation ends, then its errors. */
export function watching(): (line: string) => string[] {
  let compiled: string[] = [];
  return (line) => {
    if (STARTS.test(line)) {
      compiled = [];
      return ["Type check started"];
    }
    if (ENDS.test(line)) return [...typeErrors(compiled), "Type check done"];
    compiled.push(line);
    return [];
  };
}

function main(root: string, args: string[]): void {
  const tsc = checkingTsc(root, args);
  const watch = args.includes("--watch");
  const options = [
    "--noEmit",
    "--pretty",
    "false",
    "--noErrorTruncation",
    ...(watch ? ["--preserveWatchOutput"] : []),
    ...args,
  ];
  const child = spawn(tsc.file, [...tsc.args, ...options], { stdio: ["ignore", "pipe", "inherit"] });
  const printed: string[] = [];
  const print = watching();
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (watch) for (const shown of print(line)) console.log(shown);
    else printed.push(line);
  });
  child.on("close", (code) => {
    // 1 and 2 are tsc saying it found errors: the gate counts them, so only a tsc that broke fails.
    if (watch || code === null || code > 2) {
      console.log(printed.join("\n"));
      process.exit(code ?? 1);
    }
    console.log(typeErrors(printed).join("\n"));
  });
}

if (import.meta.main) main(process.cwd(), process.argv.slice(2));
