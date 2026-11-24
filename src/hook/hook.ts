import { type CheckedTurn, checkTurn, startSession, startTurn } from "../core/check.ts";
import { configuredRoot, gatesOf, readGatesFiles } from "../core/config.ts";
import { isRecord, messageOf, parseJson } from "../core/json.ts";
import { broken, failures, summary, toolsMissing, toolsToInstall } from "../core/report.ts";
import { type Judged, judge, waivesOf } from "../core/send-back.ts";
import { endSession } from "../core/watch.ts";
import {
  forgetConduct,
  forgetTold,
  forgetTurn,
  readTurn,
  tellConductOnce,
  tellOnce,
  turnRoot,
  writeTurn,
} from "../core/turn-state.ts";

export interface HookInput {
  session_id?: string;
  stop_hook_active?: boolean;
  cwd?: string;
  source?: string;
  last_assistant_message?: string;
}

export interface HookOutput {
  decision?: "block";
  reason?: string;
  systemMessage: string;
  hookSpecificOutput?: { hookEventName: "UserPromptSubmit"; additionalContext: string };
}

/** The events the plugin hooks, each named as the CLI takes it. */
export const HOOK_EVENTS = ["session-start", "turn-start", "check", "session-end"] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(word: string | undefined): word is HookEvent {
  return HOOK_EVENTS.some((event) => event === word);
}

export function parseHookInput(text: string): HookInput {
  const input = parseJson(text);
  if (!isRecord(input)) return {};
  const { session_id, stop_hook_active, cwd, source, last_assistant_message } = input;
  return {
    ...(typeof session_id === "string" ? { session_id } : {}),
    ...(typeof stop_hook_active === "boolean" ? { stop_hook_active } : {}),
    ...(typeof cwd === "string" ? { cwd } : {}),
    ...(typeof source === "string" ? { source } : {}),
    ...(typeof last_assistant_message === "string" ? { last_assistant_message } : {}),
  };
}

function sendBacks(count: number): string {
  return count === 1 ? "1 send-back" : `${count} send-backs`;
}

// How the stop ends, after the totals: sent back, stopped by the cap, or handed back once the agent was sent back.
function ending({ sendBack, count, max, open }: Judged): string {
  if (sendBack) return `the agent is sent back to fix it (${count} of ${max})`;
  if (open.length) return max === 0 ? "send-backs are off" : `stopped after ${sendBacks(count)}`;
  return count ? `after ${sendBacks(count)}` : "";
}

// What the agent is told besides the reports: where it stands, and what became of its waive lines.
function told({ count, max, waived, fallen, unknown, gates }: Judged): string[] {
  const names = (list: string[]) => list.join(", ");
  return [
    `This is send-back ${count} of ${max}.`,
    ...(waived.length ? [`Waived this turn, not to fix: ${names(waived.map(({ name }) => name))}.`] : []),
    ...(fallen.length
      ? [`Your waiver of ${names(fallen)} no longer holds: its report changed. Fix it, or waive it again.`]
      : []),
    ...(unknown.length ? [`No gate is named ${names(unknown)}. The gates of this turn: ${names(gates)}.`] : []),
  ];
}

/**
 * A red gate the agent did not waive sends it back with the reports, until the turn reaches its cap: a fix that
 * breaks another gate is caught, and a gate the agent cannot satisfy never loops. The owner sees each stop, the
 * waived gates with their reasons, and why the turn ended.
 */
export function stopOutput(turn: CheckedTurn, judged: Judged, brief = false): HookOutput {
  const systemMessage = summary(turn, ending(judged), judged.waived);
  if (!judged.sendBack) return { systemMessage };
  const reason = failures({ ...turn, outcomes: judged.open }, told(judged), brief);
  return { decision: "block", reason, systemMessage };
}

// When the gates cannot run, such as with a gates file that does not parse, only the owner is told: a crash would
// show them a stack trace at best, and the agent is not to blame.
function cannotRun(error: unknown): HookOutput {
  return { systemMessage: broken(messageOf(error)) };
}

/**
 * A session that starts starts the watches of its repo. Whatever stops them is told at the prompt, which reads the
 * same gates.
 */
function sessionHook(session: string, cwd: string): void {
  try {
    const root = configuredRoot(cwd);
    if (root !== undefined) startSession(session, root);
  } catch {}
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
    const { prompts } = gatesOf(readGatesFiles(root));
    return {
      systemMessage: toolsMissing(missing),
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: toolsToInstall(missing, prompts.missingTools),
      },
    };
  } catch (error) {
    return cannotRun(error);
  }
}

/**
 * A stop checks the repo its turn started in, whatever folder the agent stops in, or that folder's repo otherwise,
 * reads the gates the agent's last message waives, and records what it told the agent for the next stop of the turn.
 */
async function stopHook(
  session: string,
  cwd: string,
  retry: boolean,
  message: string,
): Promise<HookOutput | undefined> {
  const root = turnRoot(session, retry) ?? configuredRoot(cwd);
  if (root === undefined) return undefined;
  try {
    const checked = await checkTurn(session, root);
    const turn = readTurn(session, root);
    if (turn === undefined) throw new Error("the turn was not recorded after its check.");
    const { gates, refused, maxSendBacks } = gatesOf(turn.config);
    const names = [...gates.map(({ name }) => name), ...refused.map(({ name }) => name)];
    const judged = judge(checked, waivesOf(message), names, maxSendBacks, turn.sendBacks);
    writeTurn(session, root, { ...turn, sendBacks: judged.state });
    const brief = judged.sendBack && !tellConductOnce(session, root);
    return stopOutput(checked, judged, brief);
  } catch (error) {
    return cannotRun(error);
  }
}

/**
 * Handles a hook event of a coding agent: Claude Code and Codex send the same input and read the same output. It does
 * nothing outside git, or in a repo with no gates file.
 */
export async function handleHook(event: HookEvent, text: string): Promise<HookOutput | undefined> {
  const {
    session_id: session,
    stop_hook_active: retry = false,
    cwd = process.cwd(),
    source,
    last_assistant_message: message = "",
  } = parseHookInput(text);
  if (session === undefined) return undefined;
  // A session that starts, resumes or is cleared asks again for the missing tools; a compaction goes on as it was.
  if (event === "session-start") {
    if (source !== "compact") forgetTold(session);
    // A compaction may have summed up how to act on a send-back: the next one says it whole again.
    forgetConduct(session);
    sessionHook(session, cwd);
    return undefined;
  }
  // Codex gives a session that ends 3 s at most: the hook only stops the watches no other session uses.
  if (event === "session-end") {
    endSession(session);
    return undefined;
  }
  return event === "turn-start" ? promptHook(session, cwd) : stopHook(session, cwd, retry, message);
}
