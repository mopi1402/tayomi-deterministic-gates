// Claude Code's MessageDisplay hook, run on each batch of lines of a reply as it streams: it shows the batch without
// its waive lines, which Claude Code would print raw. Display only: the stored message, the one the stop reads, keeps
// them. A batch with no waive line gets no answer, so the hook never takes the place of another display hook there.
import { readFileSync } from "node:fs";
import { isRecord, parseJson } from "../core/json.ts";
import { hideWaives } from "../core/waive-line.ts";

/** What the hook prints for a batch: the batch without its waive lines, or nothing when it holds none. */
export function displayOf(input: string): string | undefined {
  const payload = parseJson(input);
  if (!isRecord(payload) || typeof payload.delta !== "string") return undefined;
  const shown = hideWaives(payload.delta);
  if (shown === payload.delta) return undefined;
  // An empty displayContent is the protocol's own way to show nothing for the batch.
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "MessageDisplay", displayContent: shown } });
}

if (import.meta.main) {
  const output = displayOf(readFileSync(0, "utf8"));
  if (output) console.log(output);
}
