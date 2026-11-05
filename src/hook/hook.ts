import { type CheckedTurn, checkTurn, startTurn } from "../core/check.ts";
import { configuredRoot } from "../core/config.ts";
import { isRecord, messageOf, parseJson } from "../core/json.ts";
import { broken, failures, summary } from "../core/report.ts";
import { forgetTurn, turnRoot } from "../core/turn-state.ts";

export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
  cwd?: string;
}

export interface HookOutput {
  decision?: "block";
  reason?: string;
  systemMessage: string;
}

export function parseHookInput(text: string): HookInput {
  const input = parseJson(text);
  if (!isRecord(input)) return {};
  const { session_id, stop_hook_active, cwd } = input;
  return {
    ...(typeof session_id === "string" ? { session_id } : {}),
    ...(typeof stop_hook_active === "boolean" ? { stop_hook_active } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
  };
}

/**
 * A failed gate sends the agent back once with the reports. If it stops again with one still failing, only the owner
 * is told, so a gate the agent cannot satisfy never loops.
 */
export function stopOutput(turn: CheckedTurn, retry: boolean): HookOutput {
  const sentBack = turn.outcomes.some((outcome) => !outcome.ok) && !retry;
  const systemMessage = summary(turn, sentBack ? "the agent is sent back to fix it" : "the agent handed back anyway");
  return sentBack ? { decision: "block", reason: failures(turn), systemMessage } : { systemMessage };
}

// When the gates cannot run, such as with a gates file that does not parse, only the owner is told: a crash would
// show them a stack trace at best, and the agent is not to blame.
function cannotRun(error: unknown): HookOutput {
  return { systemMessage: broken(messageOf(error)) };
}

/** A prompt ends the turn in progress; from a folder with no gates, or when the turn cannot start, no check will look for a new one. */
async function promptHook(session: string, cwd: string): Promise<HookOutput | undefined> {
  forgetTurn(session);
  const root = configuredRoot(cwd);
  if (root === undefined) return undefined;
  try {
    await startTurn(session, root);
    return undefined;
  } catch (error) {
    return cannotRun(error);
  }
}

/** A stop checks the repo its turn started in, whatever folder the agent stops in, or that folder's repo otherwise. */
async function stopHook(session: string, cwd: string, retry: boolean): Promise<HookOutput | undefined> {
  const root = turnRoot(session, retry) ?? configuredRoot(cwd);
  if (root === undefined) return undefined;
  try {
    return stopOutput(await checkTurn(session, root), retry);
  } catch (error) {
    return cannotRun(error);
  }
}

/**
 * Handles a hook event of a coding agent: Claude Code and Codex send the same input and read the same output. It does
 * nothing outside git, or in a repo with no gates file.
 */
export async function handleHook(event: "turn-start" | "check", text: string): Promise<HookOutput | undefined> {
  const { session_id: session, stop_hook_active: retry = false, cwd = process.cwd() } = parseHookInput(text);
  if (session === undefined) return undefined;
  return event === "turn-start" ? promptHook(session, cwd) : stopHook(session, cwd, retry);
}
