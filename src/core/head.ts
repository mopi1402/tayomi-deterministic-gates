import { commitFiles, headMoves } from "./snapshot.ts";

// What takes HEAD to a commit the turn did not write, as the reflog names it. Any other move is a commit of the turn,
// as an amend or a cherry-pick: checking too much beats leaving a hole.
const NOT_ITS_COMMIT = /^(checkout|pull|merge|rebase|reset)\b/;
// A merge the turn commits brings the code of a branch too: of its files, the turn wrote the conflicts it resolved.
const ELSEWHERE = new RegExp(`${NOT_ITS_COMMIT.source}|^commit \\(merge\\)`);

/** HEAD as a turn starts: its commit, and how many moves its reflog holds. */
export interface Head {
  head?: string;
  moves?: number;
}

/** The last move of a turn that took HEAD to code the turn did not write. */
export interface Moved {
  /** The commit HEAD reached: what the tree differs from since is the turn's. */
  to: string;
  how: string;
  /** The files of the commits the turn made, which the commit reached may hold already, as after a rebase. */
  committed: string[];
}

export function headOf(root: string): Head {
  const moves = headMoves(root);
  const head = moves.at(-1)?.to;
  return { moves: moves.length, ...(head === undefined ? {} : { head }) };
}

/**
 * Whether HEAD moved, since the turn started, to code the turn did not write: a checkout, a pull, a merge, a rebase or
 * a reset. Nothing when it did not, or when the reflog no longer tells: all the turn changed is then checked.
 */
export function movedSince(root: string, { head, moves }: Head): Moved | undefined {
  if (moves === undefined) return undefined;
  const all = headMoves(root);
  if (all[moves - 1]?.to !== head) return undefined;
  // A move that reaches the commit it left brings no code, as a new branch or a stash does.
  const since = all.slice(moves).filter(({ from, to }) => from !== to);
  const last = since.findLastIndex(({ how }) => ELSEWHERE.test(how));
  const move = since[last];
  if (move === undefined) return undefined;
  const own = since.filter(({ how }) => !NOT_ITS_COMMIT.test(how));
  return { to: move.to, how: move.how, committed: own.flatMap(({ to }) => commitFiles(root, to)) };
}
