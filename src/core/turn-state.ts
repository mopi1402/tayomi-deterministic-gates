import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatesFiles } from "./config.ts";
import { isRecord, isStringArray, isStringRecord, readJsonFile } from "./json.ts";

/** A red gate the agent chose to leave, with why, bound to the fingerprint of the report it saw. */
export interface Waiver {
  reason: string;
  report: string;
}

/**
 * What the stops of a turn have told the agent so far: how many times it was sent back, the gates it waived, and the
 * fingerprint of each red report of the last check, which a waiver read at the next stop is bound to.
 */
export interface SendBacks {
  count: number;
  waivers: Record<string, Waiver>;
  reports: Record<string, string>;
}

/**
 * What a turn started from: the commit, the reports of its compared gates, and the gates files themselves, since a
 * turn is checked with the gates it started with. A turn the owner interrupts never reaches its check: it stays
 * unchecked until the next turn of its repo. Once checked, what its stops told the agent.
 */
export interface TurnState {
  start: string;
  baselines: Record<string, string>;
  config: GatesFiles;
  checked: boolean;
  sendBacks?: SendBacks;
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
 * than the one it started in, and a prompt from a folder with no gates starts a turn no check looks for. With them,
 * the tools each repo was missing when the agent was last told, so it is not asked again at every prompt.
 */
interface SessionState {
  current?: string;
  turns: Record<string, TurnState>;
  told?: Record<string, string[]>;
  /** The repos a send-back of the session told the agent how to act in: the next ones there say it in one line. */
  conductTold?: string[];
}

const EMPTY: SessionState = { turns: {} };

function stateFile(session: string): string {
  return join(tmpdir(), `gates-session-${session.replace(/[^\w-]/g, "")}.json`);
}

function isWaiver(value: unknown): value is Waiver {
  return isRecord(value) && typeof value.reason === "string" && typeof value.report === "string";
}

function isSendBacks(value: unknown): value is SendBacks {
  return (
    isRecord(value) &&
    typeof value.count === "number" &&
    isRecord(value.waivers) &&
    Object.values(value.waivers).every(isWaiver) &&
    isStringRecord(value.reports)
  );
}

function isTurnState(value: unknown): value is TurnState {
  return (
    isRecord(value) &&
    typeof value.start === "string" &&
    isStringRecord(value.baselines) &&
    isGatesFiles(value.config) &&
    typeof value.checked === "boolean" &&
    (value.sendBacks === undefined || isSendBacks(value.sendBacks))
  );
}

function isSessionState(value: unknown): value is SessionState {
  return (
    isRecord(value) &&
    (value.current === undefined || typeof value.current === "string") &&
    isRecord(value.turns) &&
    Object.values(value.turns).every(isTurnState) &&
    (value.told === undefined || (isRecord(value.told) && Object.values(value.told).every(isStringArray))) &&
    (value.conductTold === undefined || isStringArray(value.conductTold))
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
  const { turns, ...state } = readSession(session);
  const unchecked = Object.entries(turns).filter(([, kept]) => !kept.checked);
  writeSession(session, { ...state, current: root, turns: { ...Object.fromEntries(unchecked), [root]: turn } });
}

/** Ends the turn in progress without a check, as a prompt from a folder with no gates, or a failed start, does. */
export function forgetTurn(session: string): void {
  forget(session, "current");
}

function forget(session: string, key: "current" | "told" | "conductTold"): void {
  const { [key]: had, ...state } = readSession(session);
  if (had !== undefined) writeSession(session, state);
}

/**
 * Whether the agent is yet to be told that the repo misses these tools, in this session: once told, a list is not
 * told again until it changes, since asking at every prompt someone who cannot install a tool only gets in the way.
 */
export function tellOnce(session: string, root: string, missing: string[]): boolean {
  const state = readSession(session);
  const told = state.told?.[root] ?? [];
  if (told.join("\n") === missing.join("\n")) return false;
  writeSession(session, { ...state, told: { ...state.told, [root]: missing } });
  return missing.length > 0;
}

/**
 * Whether the agent is yet to be told how to act on a send-back of this repo, in this session: said once, it stays in
 * its context, and saying it again at every send-back only costs it tokens. Each repo has its own words for it.
 */
export function tellConductOnce(session: string, root: string): boolean {
  const state = readSession(session);
  const told = state.conductTold ?? [];
  if (told.includes(root)) return false;
  writeSession(session, { ...state, conductTold: [...told, root] });
  return true;
}

/** Forgets that the agent was told how to act: a session that starts again, or compacts, may have lost it. */
export function forgetConduct(session: string): void {
  forget(session, "conductTold");
}

/** Forgets what the agent was told of missing tools, so a session that starts again, or resumes, is told again. */
export function forgetTold(session: string): void {
  forget(session, "told");
}

/**
 * The repo of the turn a check is about, whatever folder the agent stops in. A check that follows its own turn start
 * finds it unchecked, and the retry of a turn sent back finds it checked: any other check has no turn in progress.
 */
export function turnRoot(session: string, retry: boolean): string | undefined {
  const { current, turns } = readSession(session);
  if (current === undefined) return undefined;
  const turn = turns[current];
  return turn && (!turn.checked || retry) ? current : undefined;
}
