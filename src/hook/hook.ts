import { type CheckedTurn, checkTurn, startTurn } from "../core/check.ts";
import { configuredRoot } from "../core/config.ts";
import { isRecord, messageOf, parseJson } from "../core/json.ts";
import { broken, failures, summary, toolsMissing, toolsToInstall } from "../core/report.ts";
import { failed } from "../core/run.ts";
import { forgetTold, forgetTurn, tellOnce, turnRoot } from "../core/turn-state.ts";

export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
  cwd?: string;
  source?: string;
}

export interface HookOutput {
  decision?: "block";
  reason?: string;
  systemMessage: string;
  hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string };
}

export type HookEvent = "session-start" | "turn-start" | "check";

export function parseHookInput(text: string): HookInput {
  const input = parseJson(text);
  if (!isRecord(input)) return {};
  const { session_id, stop_hook_active, cwd, source } = input;
  return {
    ...(typeof session_id === "string" ? { session_id } : {}),
    ...(typeof stop_hook_active === "boolean" ? { stop_hook_active } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof source === "string" ? { source } : {}),
  };
}

/**
 * A failed gate sends the agent back once with the reports. If it stops again with one still failing, only the owner
 * is told, so a gate the agent cannot satisfy never loops.
 */
export function stopOutput(turn: CheckedTurn, retry: boolean): HookOutput {
  const sentBack = turn.outcomes.some(failed) && !retry;
  const systemMessage = summary(turn, sentBack ? "the agent is sent back to fix it" : "the agent handed back anyway");
  return sentBack ? { decision: "block", reason: failures(turn), systemMessage } : { systemMessage };
}

// When the gates cannot run, such as with a gates file that does not parse, only the owner is told: a crash would
// show them a stack trace at best, and the agent is not to blame.
function cannotRun(error: unknown): HookOutput {
  return { systemMessage: broken(messageOf(error)) };
}

/**
 * A prompt ends the turn in progress; from a folder with no gates, or when the turn cannot start, no check will look
 * for a new one. When the gates of the repo miss tools, the agent is asked once to install them.
 */
async function promptHook(session: string, cwd: string): Promise<HookOutput | undefined> {
  try {
    forgetTurn(session);
    const root = configuredRoot(cwd);
    if (root === undefined) return undefined;
    const missing = await startTurn(session, root);
    if (!tellOnce(session, root, missing)) return undefined;
    return {
      systemMessage: toolsMissing(missing),
      hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: toolsToInstall(missing) },
    };
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
export async function handleHook(event: HookEvent, text: string): Promise<HookOutput | undefined> {
  const { session_id: session, stop_hook_active: retry = false, cwd = process.cwd(), source } = parseHookInput(text);
  if (session === undefined) return undefined;
  // A session that starts, resumes or is cleared asks again for the missing tools; a compaction goes on as it was.
  if (event === "session-start") {
    if (source !== "compact") forgetTold(session);
    return undefined;
  }
  return event === "turn-start" ? promptHook(session, cwd) : stopHook(session, cwd, retry);
}
