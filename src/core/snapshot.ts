import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/** Runs git in the repo, and gives what it printed, trimmed. */
function git(root: string, args: string[], { env = process.env, input }: GitOptions = {}): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", env, input, stdio: "pipe" }).trim();
}

// One NUL after each path, which git otherwise quotes and escapes when it holds an accent.
function paths(printed: string): string[] {
  return printed.split("\0").filter(Boolean);
}

export function repoRoot(cwd: string): string | undefined {
  try {
    return git(cwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return undefined;
  }
}

/** Every file of the repo, tracked or not, the ignored ones left out. */
export function listFiles(root: string): string[] {
  return paths(git(root, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]));
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
  return git(root, ["commit-tree", tree, "-m", message], { env: identity });
}

/**
 * The tree of the working tree, untracked files included and ignored files left out. It changes neither the index
 * nor the files.
 */
export function workingTree(root: string): string {
  const dir = mkdtempSync(join(tmpdir(), "gates-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  try {
    // Seeded from the real index, git hashes only the files changed since it was written: hashing every file of a
    // large repo takes seconds, twice per turn. The copy keeps the date of the real index, since git trusts a file's
    // size and date only when the index is older than the file: a newer date would hide a same-size rewrite.
    const realIndex = resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
    if (existsSync(realIndex)) cpSync(realIndex, env.GIT_INDEX_FILE, { preserveTimestamps: true });
    git(root, ["add", "--all"], { env });
    return git(root, ["write-tree"], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Records the working tree as a commit that no branch points to, for the tools given the turn, with its tree. */
export function snapshot(root: string): { commit: string; tree: string } {
  const tree = workingTree(root);
  return { commit: commitOf(root, tree, "gates turn"), tree };
}

/**
 * A commit with no file: compared with it, every file of the repo is new. A commit rather than the bare empty tree,
 * since the tools given the turn, such as jscpd, resolve a commit and not a tree.
 */
export function emptyCommit(root: string): string {
  return commitOf(root, git(root, ["hash-object", "-t", "tree", "--stdin"], { input: "" }), "gates empty");
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

/** The files that differ between two commits or trees, the deleted ones included. */
export function changedSince(root: string, start: string, end = workingTree(root)): string[] {
  return paths(git(root, ["diff", "-z", "--name-only", start, end])).sort();
}
