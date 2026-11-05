import { readFileSync } from "node:fs";
import { checkAll } from "./core/check.ts";
import { reports, summary } from "./core/report.ts";
import { repoRoot } from "./core/snapshot.ts";
import { handleHook } from "./hook/hook.ts";

function readStdin(): string {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const [command, event] = process.argv.slice(2);

if (command === "hook" && (event === "turn-start" || event === "check")) {
  const output = await handleHook(event, readStdin());
  if (output) console.log(JSON.stringify(output));
} else if (command === "check" && event === undefined) {
  const root = repoRoot(process.cwd());
  if (root === undefined) {
    console.error("Not in a git repository.");
    process.exitCode = 2;
  } else {
    const all = await checkAll(root);
    console.log([summary(all), ...reports(all.outcomes)].join("\n\n"));
    if (all.outcomes.some((outcome) => !outcome.ok)) process.exitCode = 1;
  }
} else {
  console.error("Usage: node src/cli.ts hook <turn-start|check>, or node src/cli.ts check");
  process.exitCode = 2;
}
