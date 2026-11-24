#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { checkAll } from "./core/check.ts";
import { configuredRoot } from "./core/config.ts";
import { messageOf } from "./core/json.ts";
import { broken, reports, results, summary } from "./core/report.ts";
import { failed } from "./core/run.ts";
import { HOOK_EVENTS, handleHook, isHookEvent } from "./hook/hook.ts";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/** What the command prints when it is called with words it does not know, named by the bin of the npm package. */
export const USAGE = `Usage: deterministic-gates check [--format json], or deterministic-gates hook <${HOOK_EVENTS.join("|")}>`;

// The helpers of the engine run only on import.meta.main, which came with Node 24.2: below, they are a silent green.
const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
const oldNode =
  major < 24 || (major === 24 && minor < 2)
    ? `Node 24.2 or later is needed, this is ${process.versions.node}.`
    : undefined;

async function main([command, ...words]: string[]): Promise<void> {
  const [event] = words;
  // For a tool, such as a CI or a script, where the text is for the one who reads the terminal.
  const json = words.join(" ") === "--format json";
  if (oldNode !== undefined) {
    if (command === "hook") console.log(JSON.stringify({ systemMessage: broken(oldNode) }));
    else {
      console.error(oldNode);
      process.exitCode = 2;
    }
  } else if (command === "hook" && isHookEvent(event)) {
    const output = await handleHook(event, readStdin());
    if (output) console.log(JSON.stringify(output));
  } else if (command === "check" && (json || event === undefined)) {
    const root = configuredRoot(process.cwd());
    if (root === undefined) {
      console.error("Not in a git repository, or no .gates.json in it.");
      process.exitCode = 2;
    } else {
      try {
        const all = await checkAll(root);
        console.log(json ? JSON.stringify(results(all), null, 2) : [summary(all), ...reports(all)].join("\n\n"));
        if (all.outcomes.some(failed)) process.exitCode = 1;
      } catch (error) {
        console.error(`Could not run: ${messageOf(error)}`);
        process.exitCode = 2;
      }
    }
  } else {
    console.error(USAGE);
    process.exitCode = 2;
  }
}

// Run as a program, never as a test imports it. Below Node 24.2, import.meta.main is undefined: the program runs then,
// to say that Node is too old.
if (import.meta.main !== false) await main(process.argv.slice(2));
