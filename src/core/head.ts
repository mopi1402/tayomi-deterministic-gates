import { branchTips, type Commit, commitsPast, hasCommit, isIn } from "./snapshot.ts";

// What tells the code a turn wrote from the code that came with a branch it checked out, pulled, merged or rebased on.
// Nothing here reads how HEAD moved, which git tells in too many ways: only which commits were there before.
//
// A commit was there when a branch held it as the session first started a turn in the repo, when HEAD was on it as a
// turn of the session started, since the turns before have judged it, or when it was committed before the turn, as
// one a fetch brought, unless a stop of the session saw it as its own already. Any other commit is one the session
// made, by whatever command, in whatever worktree: checking too much beats leaving a hole.

/** What a turn records of HEAD as it starts: its commit, when the repo has one, and when, in milliseconds. */
export interface Head {
  head?: string;
  at?: number;
}

/**
 * What a session knows of the commits of a repo: the tips of its branches as its first turn there started, with the
 * commit each of its turns started on, and the commits it made since, as its stops saw them.
 */
export interface There {
  known: string[];
  made: string[];
}

/** The code under HEAD that the session did not write, when it is not the one the turn started on. */
export interface Moved {
  /** The commits that were there, nearest under HEAD: a file like the one any of them holds is not the turn's. */
  under: string[];
  /** The one of them the turn did not start on, when there is one: where a gate given the turn starts from. */
  to?: string;
  /** Whether one of them holds code the turn did not start on, where the others only hold less of it. */
  arrived: boolean;
}

export function headOf(root: string): Head {
  const { head } = branchTips(root);
  return { ...(head === undefined ? {} : { head }), at: Date.now() };
}

/**
 * What a session knows of a repo as a turn starts there, from what it knew: the commit HEAD is on was there, since
 * a turn that made it has been judged on it. Before its first turn, the tips of the branches were.
 */
export function thereOf(root: string, before?: There): There {
  const { head, tips } = branchTips(root);
  if (before === undefined) return { known: tips, made: [] };
  return { known: [...new Set([...before.known, ...(head === undefined ? [] : [head])])], made: before.made };
}

/** The commits the session made, among the ones past what it knew: the ones it saw as its own, and the ones of the turn. */
function madeOf(past: Commit[], { made }: There, at: number): Commit[] {
  const seen = new Set(made);
  const started = Math.floor(at / 1000);
  return past.filter((commit) => seen.has(commit.hash) || commit.at >= started);
}

/**
 * What the session knows once a turn that started then stops: with the commits the turn made, on whatever branch, so
 * that they stay its own in the turns after. Less the known commits git no longer has, as after a deleted branch.
 */
export function observed(root: string, there: There, at: number): There {
  const seen = (known: string[]): There => {
    const mine = madeOf(commitsPast(root, branchTips(root).tips, known), there, at);
    return { known, made: [...new Set([...there.made, ...mine.map(({ hash }) => hash)])] };
  };
  try {
    return seen(there.known);
  } catch {
    const kept = there.known.filter((commit) => hasCommit(root, commit));
    try {
      return seen(kept);
    } catch {
      return { known: kept, made: there.made };
    }
  }
}

/** The commits that were there, nearest under a commit: itself, or the ones under the commits the session made. */
function under(tip: string, made: Map<string, string[]>): string[] {
  const there = new Set<string>();
  const seen = new Set<string>();
  const left = [tip];
  for (let commit = left.pop(); commit !== undefined; commit = left.pop()) {
    if (seen.has(commit)) continue;
    seen.add(commit);
    const parents = made.get(commit);
    if (parents === undefined) there.add(commit);
    else left.push(...parents);
  }
  return [...there];
}

/**
 * Whether the code under HEAD that the session did not write changed since the turn started, as after a checkout, a
 * pull, a merge, a rebase or a reset. Nothing when it did not, as after a commit of the turn, or a branch it left and
 * came back to; nor when nothing tells any more, where all the turn changed is checked.
 */
export function movedSince(root: string, { head, at }: Head, there: There): Moved | undefined {
  const now = branchTips(root).head;
  if (head === undefined || at === undefined || now === undefined || now === head) return undefined;
  let past: Commit[];
  try {
    past = commitsPast(root, [now, head], there.known);
  } catch {
    return undefined;
  }
  const made = new Map(madeOf(past, there, at).map(({ hash, parents }) => [hash, parents]));
  const [before, after] = [under(head, made), under(now, made)];
  if (after.length === before.length && after.every((commit) => before.includes(commit))) return undefined;
  const brought = after.find((commit) => !before.some((had) => isIn(root, commit, had)));
  const to = brought ?? after.find((commit) => !before.includes(commit));
  return { under: after, arrived: brought !== undefined, ...(to === undefined ? {} : { to }) };
}
