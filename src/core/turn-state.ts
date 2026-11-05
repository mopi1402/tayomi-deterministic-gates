import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatesFiles } from "./config.ts";
import { isRecord, isStringRecord, readJsonFile } from "./json.ts";

/**
 * What a turn started from: the commit, the reports of its compared gates, and the gates files themselves, since a
 * turn is checked with the gates it started with. A turn the owner interrupts never reaches its check: it stays
 * unchecked until the next turn of its repo.
 */
export interface TurnState {
  start: string;
  baselines: Record<string, string>;
  config: GatesFiles;
  checked: boolean;
}

function isGatesFiles(value: unknown): value is GatesFiles {
  return (
    isRecord(value) &&
    (value.shared === undefined || typeof value.shared === "string") &&
    (value.local === undefined || typeof value.local === "string")
  );
}

/**
 * The turns of a session, one per repo, and the repo of the turn in progress. The agent may stop in another folder
 * than the one it started in, and a prompt from a folder with no gates starts a turn no check looks for.
 */
interface SessionState {
  current: string | null;
  turns: Record<string, TurnState>;
}

const EMPTY: SessionState = { current: null, turns: {} };

function stateFile(session: string): string {
  return join(tmpdir(), `gates-session-${session.replace(/[^\w-]/g, "")}.json`);
}

function isTurnState(value: unknown): value is TurnState {
  return (
    isRecord(value) &&
    typeof value.start === "string" &&
    isStringRecord(value.baselines) &&
    isGatesFiles(value.config) &&
    typeof value.checked === "boolean"
  );
}

function isSessionState(value: unknown): value is SessionState {
  return (
    isRecord(value) &&
    (value.current === null || typeof value.current === "string") &&
    isRecord(value.turns) &&
    Object.values(value.turns).every(isTurnState)
  );
}

function readSession(session: string): SessionState {
  const state = readJsonFile(stateFile(session));
  return isSessionState(state) ? state : EMPTY;
}

function writeSession(session: string, state: SessionState): void {
  writeFileSync(stateFile(session), JSON.stringify(state));
}

/** The turn of a repo: the one in progress, or one interrupted before it was checked. */
export function readTurn(session: string, root: string): TurnState | undefined {
  return readSession(session).turns[root];
}

/**
 * Records the turn of a repo, as the one in progress. The checked turns of the other repos go: only the one in
 * progress is read again, by its retry.
 */
export function writeTurn(session: string, root: string, turn: TurnState): void {
  const { turns } = readSession(session);
  const unchecked = Object.entries(turns).filter(([, kept]) => !kept.checked);
  writeSession(session, { current: root, turns: { ...Object.fromEntries(unchecked), [root]: turn } });
}

/** Ends the turn in progress without a check, as a prompt from a folder with no gates, or a failed start, does. */
export function forgetTurn(session: string): void {
  const state = readSession(session);
  if (state.current !== null) writeSession(session, { ...state, current: null });
}

/**
 * The repo of the turn a check is about, whatever folder the agent stops in. A check that follows its own turn start
 * finds it unchecked, and the retry of a turn sent back finds it checked: any other check has no turn in progress.
 */
export function turnRoot(session: string, retry: boolean): string | undefined {
  const { current, turns } = readSession(session);
  if (current === null) return undefined;
  const turn = turns[current];
  return turn && (!turn.checked || retry) ? current : undefined;
}
