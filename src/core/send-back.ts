import { createHash } from "node:crypto";
import type { CheckedTurn } from "./check.ts";
import { failed, type Outcome } from "./run.ts";
import type { SendBacks, Waiver } from "./turn-state.ts";
import { waiveLines } from "./waive-line.ts";

/** A gate the agent's last message waives, with why. */
export interface Said {
  gate: string;
  reason: string;
}

/** The gates the agent's last message waives, in order: a later line for the same gate wins. */
export function waivesOf(message: string): Said[] {
  return [...message.matchAll(waiveLines())].map(([, gate = "", ...titles]) => ({
    gate,
    reason: (titles.find((title) => title !== undefined) ?? "").trim(),
  }));
}

/**
 * The fingerprint of a report, the same while the report says the same: numbers do not count, since an edit above a
 * problem moves its line, and a runner prints how long it took.
 */
export function fingerprint(report: string): string {
  const said = report
    .split("\n")
    .map((line) => line.trim().replace(/\d+/g, "0"))
    .filter(Boolean)
    .join("\n");
  return createHash("sha256").update(said).digest("hex").slice(0, 16);
}

/** What a stop decides, and why, for the owner and the agent. */
export interface Judged {
  sendBack: boolean;
  /** Send-backs of the turn, this one included. */
  count: number;
  max: number;
  /** The red gates not waived: the ones the agent is sent back for. */
  open: Outcome[];
  waived: { name: string; reason: string }[];
  /** Gates waived before whose report changed since: the agent judges them again. */
  fallen: string[];
  /** Names a waive line gives that no gate of the turn has, and the names of the gates of the turn. */
  unknown: string[];
  gates: string[];
  state: SendBacks;
}

const NOTHING_YET: SendBacks = { count: 0, waivers: {}, reports: {} };

/**
 * Decides whether a stop sends the agent back: a red gate it did not waive does, until the turn reaches its cap. A
 * waiver binds to the report the agent saw, the one of the last check, or of this one when it waived before it was
 * sent back, and falls when the report changes. A waive line for a gate that is not red is let go.
 */
export function judge(
  turn: CheckedTurn,
  said: Said[],
  gates: string[],
  max: number,
  before: SendBacks = NOTHING_YET,
): Judged {
  const red = turn.outcomes.filter(failed);
  const reports = Object.fromEntries(red.map(({ name, output }) => [name, fingerprint(output)]));
  const declared: Record<string, Waiver> = { ...before.waivers };
  for (const { gate, reason } of said) {
    const report = before.reports[gate] ?? reports[gate];
    if (report !== undefined && reports[gate] !== undefined) declared[gate] = { reason, report };
  }
  const waivers = Object.fromEntries(Object.entries(declared).filter(([gate, { report }]) => reports[gate] === report));
  const open = red.filter(({ name }) => waivers[name] === undefined);
  const sendBack = open.length > 0 && before.count < max;
  const count = before.count + (sendBack ? 1 : 0);
  return {
    sendBack,
    count,
    max,
    open,
    waived: Object.entries(waivers).map(([name, { reason }]) => ({ name, reason })),
    fallen: Object.keys(declared).filter((gate) => reports[gate] !== undefined && waivers[gate] === undefined),
    unknown: [...new Set(said.map(({ gate }) => gate).filter((gate) => !gates.includes(gate)))],
    gates,
    state: { count, waivers, reports },
  };
}
