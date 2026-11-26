import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface GitOptions {
  env?: NodeJS.ProcessEnv;
  input?: string;
}

/**
 * Runs git in the repo, and gives what it printed, without the line break that ends it, however long. Nothing else is
 * trimmed: the name of a file may start with a space.
 */
function git(root: string, args: string[], { env = process.env, input }: GitOptions = {}): string {
  const printed = execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env,
    input,
    stdio: "pipe",
    maxBuffer: Infinity,
  });
  return printed.replace(/\n$/, "");
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
 * The tree of the working tree, untracked files included and ignored files left out, from the files given or every
 * file of the repo. It changes neither the index nor the files. A file gone since it was listed is left out: another
 * hook may write in the tree as the agent stops, and `git add` dies on a file it listed and cannot stat.
 */
export function workingTree(root: string, files = listFiles(root)): string {
  const dir = mkdtempSync(join(tmpdir(), "gates-index-"));
  const env = { ...process.env, GIT_INDEX_FILE: join(dir, "index") };
  try {
    // Seeded from the real index, git hashes only the files changed since it was written: hashing every file of a
    // large repo takes seconds, twice per turn. The copy keeps the date of the real index, since git trusts a file's
    // size and date only when the index is older than the file: a newer date would hide a same-size rewrite.
    const realIndex = resolve(root, git(root, ["rev-parse", "--git-path", "index"]));
    if (existsSync(realIndex)) cpSync(realIndex, env.GIT_INDEX_FILE, { preserveTimestamps: true });
    git(root, ["update-index", "--add", "--remove", "-z", "--stdin"], {
      env,
      input: files.map((file) => `${file}\0`).join(""),
    });
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

/** A file as a commit holds it, or nothing when the commit does not have it. */
export function fileAt(root: string, commit: string, file: string): string | undefined {
  try {
    // However long: past the default megabyte, git would read as a commit that does not have the file.
    return execFileSync("git", ["show", `${commit}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: "pipe",
      maxBuffer: Infinity,
    });
  } catch {
    return undefined;
  }
}

/** The files that differ between two commits or trees, the deleted ones included. */
export function changedSince(root: string, start: string, end = workingTree(root)): string[] {
  return paths(git(root, ["diff", "-z", "--name-only", start, end])).sort();
}

/** A commit, with its parents, and when it was committed, in seconds. */
export interface Commit {
  hash: string;
  parents: string[];
  at: number;
}

/** The commit HEAD is on, and the tips of the branches: nothing in a repo with no commit. */
export function branchTips(root: string): { head?: string; tips: string[] } {
  try {
    const head = git(root, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    const tips = git(root, ["for-each-ref", "--format=%(objectname)", "refs/heads"]).split("\n");
    return { head, tips: [...new Set([head, ...tips.filter(Boolean)])] };
  } catch {
    return { tips: [] };
  }
}

/** The folder of git that the worktrees of a repo share: what tells that two of them are of the same repo. */
export function sharedDir(root: string): string {
  try {
    return git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  } catch {
    return root;
  }
}

/** Whether a commit is another one, or one it holds. */
export function isIn(root: string, commit: string, other: string): boolean {
  try {
    git(root, ["merge-base", "--is-ancestor", commit, other]);
    return true;
  } catch {
    return false;
  }
}

/** The commits these tips hold that none of the known commits does. It throws when git no longer has one of them. */
export function commitsPast(root: string, tips: string[], known: string[]): Commit[] {
  const input = known.map((commit) => `^${commit}\n`).join("");
  // Two lines a commit: "commit", its hash and its parents, then its time.
  const lines = git(root, ["rev-list", "--parents", "--format=%ct", "--stdin", ...tips], { input }).split("\n");
  return lines.filter(Boolean).flatMap((line, at, all) => {
    if (at % 2) return [];
    const [, hash = "", ...parents] = line.split(" ");
    return [{ hash, parents, at: Number(all[at + 1]) }];
  });
}

/** Lines a change wrote in a file: where they start, and how many. None of them, where it only cut lines out after that one. */
export interface WrittenLines {
  at: number;
  lines: number;
}

/**
 * The lines of a file the working tree wrote since a commit that has the file. The file is compared with the one of
 * the commit, not through the index, which does not know a file nobody added; and with the diff of git itself, plain,
 * whatever colours or program the owner set for it.
 */
export function writtenSince(root: string, commit: string, file: string): WrittenLines[] {
  const plain = ["--no-color", "--no-ext-diff", "--no-textconv", "--unified=0", "--inter-hunk-context=0"];
  // The name as it is: git would otherwise read the brackets of a file such as [slug].ts as a pattern.
  const diff = git(root, ["--literal-pathspecs", "diff", ...plain, `${commit}:${file}`, "--", file]);
  const hunks = diff.matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm);
  return [...hunks].map(([, at, lines = "1"]) => ({ at: Number(at), lines: Number(lines) }));
}

// Fewer names at once than a command line holds.
const NAMES_AT_ONCE = 500;

/** The ones of these files a commit has. */
export function filesAt(root: string, commit: string, files: string[]): string[] {
  const found: string[] = [];
  for (let at = 0; at < files.length; at += NAMES_AT_ONCE) {
    const names = files.slice(at, at + NAMES_AT_ONCE);
    found.push(
      ...paths(git(root, ["--literal-pathspecs", "ls-tree", "-r", "--name-only", "-z", commit, "--", ...names])),
    );
  }
  return found;
}
