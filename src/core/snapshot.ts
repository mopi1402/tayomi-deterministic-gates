import { execFileSync } from "node:child_process";
import { cpSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

function git(root: string, args: string[], env: NodeJS.ProcessEnv = process.env, input?: string): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env, input, stdio: "pipe" }).trim();
}

export function repoRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

// A commit that no branch points to, with a fixed identity so it works where git has none configured.
function commitOf(root: string, tree: string, message: string): string {
  const identity = {
    ...process.env,
    GIT_AUTHOR_NAME: "gates",
    GIT_AUTHOR_EMAIL: "turn@gates.invalid",
    GIT_COMMITTER_NAME: "gates",
    GIT_COMMITTER_EMAIL: "turn@gates.invalid",
  };
  return git(root, ["commit-tree", tree, "-m", message], identity);
}

/**
 * Records the working tree as a commit that no branch points to, untracked files included and ignored files left
 * out. It changes neither the index, nor the files, nor the history.
 */
export function snapshot(root: string): string {
  const index = join(tmpdir(), `gates-index-${process.pid}-${Date.now()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    // Seeded from the real index, git hashes only the files changed since it was written: hashing every file of a
    // large repo takes seconds, twice per turn. The copy keeps the date of the real index, since git trusts a file's
    // size and date only when the index is older than the file: a newer date would hide a same-size rewrite.
    const realIndex = resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
    if (existsSync(realIndex)) cpSync(realIndex, index, { preserveTimestamps: true });
    git(root, ["add", "--all"], env);
    return commitOf(root, git(root, ["write-tree"], env), "gates turn");
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * A commit with no file: compared with it, every file of the repo is new. A commit rather than the bare empty tree,
 * since the tools given the turn, such as jscpd, resolve a commit and not a tree.
 */
export function emptyCommit(root: string): string {
  return commitOf(root, git(root, ["hash-object", "-t", "tree", "--stdin"], process.env, ""), "gates empty");
}

export function lastCommit(root: string): string {
  try {
    return git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  } catch {
    return emptyCommit(root);
  }
}

// A rewrite of the history lets git prune the snapshots no branch points to.
export function hasCommit(root: string, commit: string): boolean {
  try {
    git(root, ["cat-file", "-e", `${commit}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

export function treeOf(root: string, commit: string): string {
  return git(root, ["rev-parse", `${commit}^{tree}`]);
}

export function changedSince(root: string, start: string, end = snapshot(root)): string[] {
  // -z: one NUL after each path, which git otherwise quotes and escapes when it holds an accent.
  return git(root, ["diff", "-z", "--name-only", "--diff-filter=d", start, end]).split("\0").filter(Boolean).sort();
}
