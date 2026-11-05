import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { changedSince, git, hasCommit, lastCommit, snapshot, treeOf } from "./snapshot.ts";
import { commitAll, tempRepo } from "../testing.ts";

let repo = "";
const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

beforeEach(() => {
  repo = tempRepo();
  writeFileSync(join(repo, ".gitignore"), "ignored.ts\n");
  writeFileSync(join(repo, "kept.ts"), "1");
  writeFileSync(join(repo, "edited.ts"), "1");
  writeFileSync(join(repo, "removed.ts"), "1");
  commitAll(repo, "start");
  writeFileSync(join(repo, "edited.ts"), "2");
  writeFileSync(join(repo, "before.ts"), "untracked before the turn");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a turn", () => {
  test("holds what changed after its start, untracked and deleted files included, ignored ones left out", () => {
    const start = snapshot(repo);
    writeFileSync(join(repo, "edited.ts"), "3");
    writeFileSync(join(repo, "new.ts"), "added in the turn");
    writeFileSync(join(repo, "ignored.ts"), "ignored");
    rmSync(join(repo, "removed.ts"));
    assert.deepEqual(changedSince(repo, start), ["edited.ts", "new.ts", "removed.ts"]);
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
    git(repo, ["add", "kept.ts"]);
    writeFileSync(join(repo, "kept.ts"), "b");
    sleep(1100);
    assert.equal(git(repo, ["show", `${snapshot(repo)}:kept.ts`]), "b");
  });

  test("sees a staged change and an unstaged change on top of it", () => {
    writeFileSync(join(repo, "kept.ts"), "staged");
    git(repo, ["add", "kept.ts"]);
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
    const empty = tempRepo();
    try {
      writeFileSync(join(empty, "first.ts"), "1");
      assert.deepEqual(changedSince(empty, lastCommit(empty)), ["first.ts"]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("leaves the index, the branch and the status untouched", () => {
    git(repo, ["add", "before.ts"]);
    const status = git(repo, ["status", "--porcelain"]);
    const head = git(repo, ["rev-parse", "HEAD"]);
    snapshot(repo);
    assert.equal(git(repo, ["status", "--porcelain"]), status);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), head);
  });
});
