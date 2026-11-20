import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, test } from "node:test";
import { hideWaives } from "../core/waive-line.ts";
import { displayOf } from "./display.ts";

const WAIVE = '[deterministic-gates:lint]: waive "the rule contradicts the task"';

function shown(output: string | undefined): unknown {
  return output === undefined ? undefined : (JSON.parse(output) as { hookSpecificOutput: unknown }).hookSpecificOutput;
}

describe("hideWaives", () => {
  test("takes out every waive line with its line ending, and leaves the rest as it is", () => {
    const text = ["I leave a gate red.", "", WAIVE, "[deterministic-gates:tests]: waive (a question first)", "End."];
    assert.equal(hideWaives(text.join("\n")), "I leave a gate red.\n\nEnd.");
  });

  test("leaves another tag, prose quoting the syntax, and a line with no reason", () => {
    const text = [
      '[view:lint]: waive "not ours"',
      `Write ${WAIVE} to waive it.`,
      "[deterministic-gates:lint]: waive",
    ].join("\n");
    assert.equal(hideWaives(text), text);
  });
});

describe("the MessageDisplay hook", () => {
  test("shows a batch without its waive lines", () => {
    assert.deepEqual(shown(displayOf(JSON.stringify({ delta: `Done.\n\n${WAIVE}\n` }))), {
      hookEventName: "MessageDisplay",
      displayContent: "Done.\n\n",
    });
  });

  test("shows nothing for a batch that is only a waive line, the last one ending mid-line", () => {
    assert.deepEqual(shown(displayOf(JSON.stringify({ delta: WAIVE, final: true }))), {
      hookEventName: "MessageDisplay",
      displayContent: "",
    });
  });

  test("answers nothing for a batch with no waive line, or a payload it cannot read", () => {
    assert.equal(displayOf(JSON.stringify({ delta: "Done.\n" })), undefined);
    assert.equal(displayOf("not json"), undefined);
    assert.equal(displayOf(JSON.stringify({ delta: 3 })), undefined);
  });

  test("runs as the command the hooks name", () => {
    const input = JSON.stringify({ hook_event_name: "MessageDisplay", delta: `${WAIVE}\n` });
    const { status, stdout } = spawnSync(process.execPath, [join(import.meta.dirname, "display.ts")], {
      input,
      encoding: "utf8",
    });
    assert.equal(status, 0);
    assert.deepEqual(shown(stdout), { hookEventName: "MessageDisplay", displayContent: "" });
  });
});
