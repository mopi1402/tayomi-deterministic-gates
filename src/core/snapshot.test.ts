import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { changedSince, hasCommit, lastCommit, snapshot, treeOf } from "./snapshot.ts";

let repo = "";
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gates-snapshot-"));
  git("init", "--quiet");
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(repo, "kept.ts"), "1");
  writeFileSync(join(repo, "edited.ts"), "1");
  writeFileSync(join(repo, "removed.ts"), "1");
  git("add", "--all");
  git("-c", "user.name=test", "-c", "user.email=test@test.invalid", "commit", "--quiet", "-m", "start");
  writeFileSync(join(repo, "edited.ts"), "2");
  writeFileSync(join(repo, "before.ts"), "untracked before the turn");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a turn", () => {
  test("holds only what changed after its start, untracked files included, ignored ones left out", () => {
    const start = snapshot(repo);
    writeFileSync(join(repo, "edited.ts"), "3");
    writeFileSync(join(repo, "new.ts"), "added in the turn");
    writeFileSync(join(repo, "ignored.ts"), "ignored");
    rmSync(join(repo, "removed.ts"));
    assert.deepEqual(changedSince(repo, start), ["edited.ts", "new.ts"]);
  });

  test("names a changed file as it is, accents and spaces included", () => {
    const start = snapshot(repo);
    writeFileSync(join(repo, "café crème.ts"), "added in the turn");
    assert.deepEqual(changedSince(repo, start), ["café crème.ts"]);
  });

  test("sees a file rewritten to the same size within the second the index was written", () => {
    // Git trusts a file's size and date only when the index is older than the file, so a copy of the index that takes
    // a newer date hides this rewrite.
    sleep(1000 - (Date.now() % 1000));
    writeFileSync(join(repo, "kept.ts"), "a");
    git("add", "kept.ts");
    writeFileSync(join(repo, "kept.ts"), "b");
    sleep(1100);
    assert.equal(git("show", `${snapshot(repo)}:kept.ts`), "b");
  });

  test("sees a staged change and an unstaged change on top of it", () => {
    writeFileSync(join(repo, "kept.ts"), "staged");
    git("add", "kept.ts");
    const start = snapshot(repo);
    writeFileSync(join(repo, "kept.ts"), "edited after staging");
    assert.deepEqual(changedSince(repo, start), ["kept.ts"]);
  });

  test("holds the same tree when the files are the same, and another one when they change", () => {
    const first = snapshot(repo);
    const second = snapshot(repo);
    assert.equal(treeOf(repo, second), treeOf(repo, first));
    writeFileSync(join(repo, "edited.ts"), "3");
    assert.notEqual(treeOf(repo, snapshot(repo)), treeOf(repo, first));
  });

  test("tells a start git still has from one it pruned", () => {
    assert.equal(hasCommit(repo, snapshot(repo)), true);
    assert.equal(hasCommit(repo, "0123456789abcdef0123456789abcdef01234567"), false);
  });

  test("runs from the last commit when its start was not recorded", () => {
    assert.deepEqual(changedSince(repo, lastCommit(repo)), ["before.ts", "edited.ts"]);
  });

  test("runs from nothing in a repo with no commit yet", () => {
    const empty = mkdtempSync(join(tmpdir(), "gates-snapshot-empty-"));
    try {
      execFileSync("git", ["init", "--quiet"], { cwd: empty });
      writeFileSync(join(empty, "first.ts"), "1");
      assert.deepEqual(changedSince(empty, lastCommit(empty)), ["first.ts"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("leaves the index, the branch and the status untouched", () => {
    git("add", "before.ts");
    const status = git("status", "--porcelain");
    const head = git("rev-parse", "HEAD");
    snapshot(repo);
    assert.equal(git("status", "--porcelain"), status);
    assert.equal(git("rev-parse", "HEAD"), head);
  });
});
