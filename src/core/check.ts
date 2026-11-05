import { existsSync } from "node:fs";
import { join } from "node:path";
import { changedGatesFiles, type Gate, gatesOf, isCompared, readGatesFiles } from "./config.ts";
import { cachedReports, cacheReports } from "./report-cache.ts";
import { check, filesOf, givenFiles, type Outcome, wholeProject } from "./run.ts";
import { changedSince, emptyCommit, hasCommit, lastCommit, snapshot, treeOf, workingTree } from "./snapshot.ts";
import { readTurn, type TurnState, writeTurn } from "./turn-state.ts";

export interface CheckedTurn {
  changed: string[];
  outcomes: Outcome[];
  skipped: string[];
  ms: number;
  note?: string;
}

/** A gate of the turn, with its outcome when it ran. */
interface Result {
  gate: Gate;
  outcome?: Outcome;
}

/** The report a compared gate compares with, or nothing when the turn has none for it. */
type Baselines = (gate: Gate) => string | undefined;

/**
 * Records the commit a turn starts from, and the reports its compared gates will compare with. After an interrupted
 * turn, the next one of the repo starts where it did, so its check also covers what the interrupted one changed.
 */
export async function startTurn(session: string, root: string): Promise<void> {
  const config = readGatesFiles(root);
  const compared = gatesOf(config).filter(isCompared);
  const interrupted = readTurn(session, root);
  if (interrupted?.checked === false) {
    writeTurn(session, root, interrupted);
    return;
  }
  const start = snapshot(root);
  const tree = treeOf(root, start);
  const cached = cachedReports(root, tree);
  const baselines = await Promise.all(
    compared.map(async (gate) => {
      const cachedReport = cached(gate);
      return {
        gate,
        ...(cachedReport === undefined ? await wholeProject(root, gate) : { ok: true, output: cachedReport }),
      };
    }),
  );
  // A report from a command that broke still serves this turn, since checking too much beats leaving a hole, but it
  // is never kept for the next one.
  cacheReports(
    root,
    tree,
    baselines.filter(({ ok }) => ok).map(({ gate, output }) => [gate, output] as const),
  );
  writeTurn(session, root, {
    start,
    baselines: Object.fromEntries(baselines.map(({ gate, output }) => [gate.name, output])),
    config,
    checked: false,
  });
}

/**
 * Runs, in parallel, each gate that looks at a changed file. A deleted file counts as changed, since a gate that
 * reads the whole project may break on it, but is never named: a gate given {files} looks at the files left, and
 * is skipped when none is.
 */
function runGates(
  root: string,
  gates: Gate[],
  changed: string[],
  turn: string,
  baselines: Baselines,
): Promise<Result[]> {
  return Promise.all(
    gates.map(async (gate) => {
      const matching = filesOf(gate, changed);
      const files = givenFiles(gate) ? matching.filter((file) => existsSync(join(root, file))) : matching;
      if (!files.length) return { gate };
      return { gate, outcome: await check(root, gate, files, turn, baselines(gate)) };
    }),
  );
}

function checkedTurn(changed: string[], results: Result[], started: number, notes: string[]): CheckedTurn {
  return {
    changed,
    outcomes: results.flatMap(({ outcome }) => (outcome ? [outcome] : [])),
    skipped: results.filter(({ outcome }) => !outcome).map(({ gate }) => gate.name),
    ms: performance.now() - started,
    note: notes.join("\n") || undefined,
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
  const results = await runGates(root, gatesOf(readGatesFiles(root)), files, empty, () => "");
  return checkedTurn(files, results, started, []);
}

// A report holds for the tree a turn ends on only if the gate ran clean on the whole project. A gate that failed
// keeps the report it started from, so what the turn added stays new until it is fixed, and a gate that did not run
// keeps none: it may still read a changed file its pattern misses, as knip reads tsconfig.json.
function endReports(results: Result[], baselines: Baselines) {
  return results.flatMap(({ gate, outcome }) => {
    if (!isCompared(gate) || !outcome) return [];
    const report = outcome.ok ? outcome.report : baselines(gate);
    return report === undefined ? [] : [[gate, report] as const];
  });
}

/**
 * Runs each gate that looks at a file the turn changed, with the gates as the turn started: an agent that weakens
 * them mid-turn changes the next turn, never its own. Without a recorded start, the turn runs from the last commit
 * with the gates of now; with a start git no longer has, from the last commit with the gates and the reports it
 * started with: checking too much beats leaving a hole.
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
  };
  const baselines: Baselines = (gate) => turn.baselines[gate.name];
  const started = performance.now();
  const end = workingTree(root);
  const changed = changedSince(root, turn.start, end);
  const results = await runGates(root, gatesOf(turn.config), changed, turn.start, baselines);
  cacheReports(root, end, endReports(results, baselines));
  writeTurn(session, root, { ...turn, checked: true });
  // A compared gate with no report from the turn start can only count its exit code: a green it did not earn is said.
  const uncompared = results
    .filter(({ gate, outcome }) => outcome && isCompared(gate) && baselines(gate) === undefined)
    .map(({ gate }) => `${gate.name} not compared: no report from the turn start, only its exit code counted`);
  const notes = [...(startNote ? [startNote] : []), ...configNote(changedGatesFiles(turn.config, now)), ...uncompared];
  return checkedTurn(changed, results, started, notes);
}

function configNote(changedFiles: string[]): string[] {
  if (!changedFiles.length) return [];
  return [`the turn changed ${changedFiles.join(" and ")}: checked with the gates as the turn started`];
}
