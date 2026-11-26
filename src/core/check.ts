import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  changedGatesFiles,
  type Gate,
  type Gates,
  gatesOf,
  isCompared,
  keepsWatch,
  type Prompts,
  readGatesFiles,
} from "./config.ts";
import { headOf, movedSince, observed, thereOf } from "./head.ts";
import { cachedReports, cacheReports } from "./report-cache.ts";
import { check, filesOf, givenFiles, missingTool, namesFiles, type Outcome, wholeProject } from "./run.ts";
import { changedSince, emptyCommit, hasCommit, lastCommit, sharedDir, snapshot, workingTree } from "./snapshot.ts";
import { readThere, readTurn, type TurnState, writeThere, writeTurn } from "./turn-state.ts";
import { judgeWatch, keepWatch, startWatch, TURN_START_MS, watchReport } from "./watch.ts";

/** What the repo says of what the agent is sent: the prompts of the whole check, and its gates, for their own. */
interface Wording {
  prompts?: Prompts;
  gates?: Pick<Gate, "name" | "omitLines" | "maxReportChars" | "prompt">[];
  /** The most characters the reports of a send-back hold, all together. */
  maxTotalReportChars?: number;
}

export interface CheckedTurn {
  changed: string[];
  outcomes: Outcome[];
  skipped: string[];
  ms: number;
  note?: string;
  showAllPasses?: boolean;
  /** As the gates the check ran with word it. */
  wording?: Wording;
}

/** A gate of the turn, with its outcome when it ran. */
interface Result {
  gate: Gate;
  outcome?: Outcome;
}

/** The report a compared gate compares with, or nothing when the turn has none for it. */
type Baselines = (gate: Gate) => string | undefined;

/** A gate whose program this machine does not have, with why. It never runs, so it never sends the agent back. */
interface Missing {
  gate: Gate;
  why: string;
}

function missingTools(root: string, gates: Gate[]): Missing[] {
  return gates.flatMap((gate) => {
    const why = missingTool(root, gate);
    return why === undefined ? [] : [{ gate, why }];
  });
}

function runnable(gates: Gate[], missing: Missing[]): Gate[] {
  return gates.filter((gate) => !missing.some((tool) => tool.gate === gate));
}

function startWatches(session: string, root: string, gates: Gate[]): void {
  for (const gate of gates) if (keepsWatch(gate)) startWatch(session, root, gate);
}

/** Starts the watches of the gates of a repo that are not running yet, so their first build runs before a turn. */
export function startSession(session: string, root: string): void {
  const { gates } = gatesOf(readGatesFiles(root));
  startWatches(session, root, runnable(gates, missingTools(root, gates)));
}

/**
 * Records the commit a turn starts from, and the reports its compared gates will compare with. After an interrupted
 * turn, the next one of the repo starts where it did, so its check also covers what the interrupted one changed.
 * Gives, gate by gate, the tools this machine misses to run the gates of the repo.
 */
export async function startTurn(session: string, root: string): Promise<string[]> {
  const config = readGatesFiles(root);
  const { gates } = gatesOf(config);
  const missing = missingTools(root, gates);
  const told = missing.map(({ gate, why }) => `${gate.name}: ${why}`);
  const compared = runnable(gates, missing).filter(isCompared);
  startWatches(session, root, runnable(gates, missing));
  const interrupted = readTurn(session, root);
  // The worktrees of a repo share its commits: what the session knows of them is of the repo, not of the folder.
  const shared = sharedDir(root);
  const there = readThere(session, shared);
  if (interrupted?.checked === false) {
    // What it committed so far stays the session's, and a commit older than this prompt is one a fetch may bring.
    if (there) writeThere(session, shared, observed(root, there, interrupted.at ?? Date.now()));
    writeTurn(session, root, { ...interrupted, at: Date.now() });
    return told;
  }
  writeThere(session, shared, thereOf(root, there));
  const head = headOf(root);
  const { commit: start, tree } = snapshot(root);
  // The turn starts before its reports are ready: a hook stopped for lack of time leaves it, never the turn before.
  writeTurn(session, root, { start, ...head, baselines: {}, config, checked: false });
  const cached = cachedReports(root, tree);
  const baselines = await Promise.all(
    compared.map(async (gate): Promise<{ gate: Gate; ok: boolean; output?: string }> => {
      const cachedReport = cached(gate);
      if (cachedReport !== undefined) return { gate, ok: true, output: cachedReport };
      if (!keepsWatch(gate)) return { gate, ...(await wholeProject(root, gate, TURN_START_MS)) };
      const output = await watchReport(session, root, gate);
      return { gate, ok: output !== undefined, output };
    }),
  );
  // A report from a command that broke still serves this turn, since checking too much beats leaving a hole, but it
  // is never kept for the next one.
  cacheReports(
    root,
    tree,
    baselines.flatMap(({ gate, ok, output }) => (ok && output !== undefined ? [[gate, output] as const] : [])),
  );
  writeTurn(session, root, {
    start,
    ...head,
    baselines: Object.fromEntries(
      baselines.flatMap(({ gate, output }) => (output === undefined ? [] : [[gate.name, output]])),
    ),
    config,
    checked: false,
  });
  return told;
}

/**
 * Runs, in parallel, each gate that looks at a changed file. A deleted file counts as changed, since a gate that
 * reads the whole project may break on it, but is never named: a gate given {files} looks at the files left, and
 * is skipped when none is. At the end of a turn of a session, a gate that keeps a watch is judged on it instead of
 * running. Elsewhere, the reports of the turn start are of code HEAD has left since.
 */
function runGates(
  root: string,
  gates: Gate[],
  changed: string[],
  turn: string,
  baselines: Baselines,
  session?: string,
  elsewhere = false,
): Promise<Result[]> {
  return Promise.all(
    gates.map(async (gate) => {
      const matching = filesOf(gate, changed);
      const files = givenFiles(gate) ? matching.filter((file) => existsSync(join(root, file))) : matching;
      if (!files.length) return { gate };
      if (session !== undefined && keepsWatch(gate))
        return { gate, outcome: await judgeWatch(session, root, gate, matching, baselines(gate), elsewhere) };
      return { gate, outcome: await check(root, gate, files, turn, baselines(gate), elsewhere) };
    }),
  );
}

function checkedTurn(
  changed: string[],
  results: Result[],
  started: number,
  notes: string[],
  { gates, prompts, maxTotalReportChars, showAllPasses }: Gates,
): CheckedTurn {
  return {
    changed,
    outcomes: results.flatMap(({ outcome }) => (outcome ? [outcome] : [])),
    skipped: results.filter(({ outcome }) => !outcome).map(({ gate }) => gate.name),
    ms: performance.now() - started,
    note: notes.join("\n") || undefined,
    ...(showAllPasses ? { showAllPasses } : {}),
    wording: { gates, prompts, maxTotalReportChars },
  };
}

/**
 * Runs each gate on every file of the repo, as if one turn had written it all: a compared gate counts every line
 * of its report, and a gate given the turn gets the empty tree. The state of the repo, for the owner or an agent
 * asked to clean it up, where the hook only ever judges a turn.
 */
export async function checkAll(root: string): Promise<CheckedTurn> {
  const started = performance.now();
  const empty = emptyCommit(root);
  const files = changedSince(root, empty);
  const config = gatesOf(readGatesFiles(root));
  const results = await runGates(root, config.gates, files, empty, () => "");
  return checkedTurn(files, results, started, refusedNotes(config.refused), config);
}

// A report holds for the tree a turn ends on only if the gate ran clean on the whole project. A gate that failed
// keeps the report it started from, so what the turn added stays new until it is fixed, and a gate that did not run
// keeps none: it may still read a changed file its pattern misses, as knip reads tsconfig.json. Elsewhere, the report
// a failed gate started from is of code HEAD has left, and is not kept either.
function endReports(results: Result[], baselines: Baselines, elsewhere: boolean) {
  return results.flatMap(({ gate, outcome }) => {
    // A gate that could not run says nothing of the tree: the report it started from was a crash, or may be stale.
    if (!isCompared(gate) || !outcome || outcome.broken) return [];
    const report = outcome.ok ? outcome.report : elsewhere ? undefined : baselines(gate);
    return report === undefined ? [] : [[gate, report] as const];
  });
}

/**
 * Runs each gate that looks at a file the turn changed, with the gates as the turn started: an agent that weakens
 * them mid-turn changes the next turn, never its own. Without a recorded start, the turn runs from the last commit
 * with the gates of now; with a start git no longer has, from the last commit with the gates and the reports it
 * started with: checking too much beats leaving a hole. When HEAD moved during the turn to code it did not write, as
 * a checkout or a pull does, the turn is only the files unlike the ones that code holds: the rest came with it.
 */
export async function checkTurn(session: string, root: string): Promise<CheckedTurn> {
  const recorded = readTurn(session, root);
  const kept = recorded !== undefined && hasCommit(root, recorded.start) ? recorded : undefined;
  const startNote =
    recorded === undefined
      ? "no turn start recorded: checked every change since the last commit"
      : kept === undefined
        ? "turn start lost (history rewritten?): checked every change since the last commit"
        : undefined;
  const now = readGatesFiles(root);
  const turn: TurnState = {
    start: kept?.start ?? lastCommit(root),
    baselines: recorded?.baselines ?? {},
    config: recorded?.config ?? now,
    checked: false,
    ...(kept ? { head: kept.head, at: kept.at } : {}),
    // What the earlier stops of the turn told the agent goes on, so its send-backs and waivers add up.
    ...(recorded?.sendBacks ? { sendBacks: recorded.sendBacks } : {}),
  };
  const shared = sharedDir(root);
  const there = readThere(session, shared);
  const moved = kept && there && movedSince(root, kept, there);
  const started = performance.now();
  const end = workingTree(root);
  const since = changedSince(root, turn.start, end);
  // A file like the one a commit under HEAD holds came with that commit: the turn did not write it.
  const changed = (moved?.under ?? []).reduce((files, commit) => {
    const unlike = new Set(changedSince(root, commit, end));
    return files.filter((file) => unlike.has(file));
  }, since);
  // Code came with a commit, or left with one: the tree the turn started on no longer tells what the turn wrote.
  const elsewhere = moved !== undefined && (moved.arrived || changed.length < since.length);
  // Where a gate given the turn starts from: then, the commit that brought the code.
  const from = (elsewhere ? moved?.to : undefined) ?? turn.start;
  // A report of code HEAD has left serves a gate whose lines name their file, to count the ones of the turn's files.
  const baselines: Baselines = (gate) => (elsewhere && !namesFiles(gate) ? undefined : turn.baselines[gate.name]);
  const config = gatesOf(turn.config);
  const { gates, refused } = config;
  const missing = missingTools(root, gates);
  for (const gate of gates) if (keepsWatch(gate)) keepWatch(root, gate);
  const results = await runGates(root, runnable(gates, missing), changed, from, baselines, session, elsewhere);
  cacheReports(root, end, endReports(results, baselines, elsewhere));
  writeTurn(session, root, { ...turn, checked: true });
  if (there) writeThere(session, shared, observed(root, there, kept?.at ?? Date.now()));
  // A compared gate with no report from the turn start can only count its exit code, and a watch has none: a green it
  // did not earn is said.
  const uncompared = results
    .filter(({ gate, outcome }) => outcome && isCompared(gate) && baselines(gate) === undefined)
    .map(({ gate }) =>
      turn.baselines[gate.name] !== undefined
        ? `${gate.name} not compared: its report of the turn start is of the code HEAD left, and its lines name no file`
        : keepsWatch(gate)
          ? `${gate.name} not judged: no report from the turn start to compare its cycle with`
          : `${gate.name} not compared: no report from the turn start, only its exit code counted`,
    );
  // Only a gate the turn concerned is named: one that would not have run anyway costs nothing to miss.
  const notRun = missing
    .filter(({ gate }) => filesOf(gate, changed).length)
    .map(({ gate, why }) => `${gate.name} not run: ${why}`);
  const notes = [
    ...(startNote ? [startNote] : []),
    ...(elsewhere ? ["HEAD moved during the turn to code it did not write: only what the turn wrote is checked"] : []),
    ...configNote(changedGatesFiles(turn.config, now)),
    ...uncompared,
    ...refusedNotes(refused),
    ...notRun,
  ];
  return checkedTurn(changed, results, started, notes, config);
}

function refusedNotes(refused: Gates["refused"]): string[] {
  return refused.map(({ name, why }) => `${name} not run, its entry is wrong: ${why}`);
}

function configNote(changedFiles: string[]): string[] {
  if (!changedFiles.length) return [];
  return [`the turn changed ${changedFiles.join(" and ")}: checked with the gates as the turn started`];
}
