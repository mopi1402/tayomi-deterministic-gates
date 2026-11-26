import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { commitAll, git, tempRepo } from "../testing.ts";
import { movedSince, observed, thereOf } from "./head.ts";

let repo = "";
const head = () => git(repo, ["rev-parse", "HEAD"]);
const LATER = Date.now() + 60_000;

// The session starts on main, then a commit is made on a branch of its own.
beforeEach(() => {
  repo = tempRepo();
  writeFileSync(join(repo, "a.ts"), "a");
  commitAll(repo, "main");
  git(repo, ["branch", "-M", "main"]);
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a commit no branch held as the session started", () => {
  test("is one the session made when it was committed since the turn started, on whatever branch", () => {
    const there = thereOf(repo);
    const started = Date.now();
    git(repo, ["checkout", "--quiet", "-b", "side"]);
    writeFileSync(join(repo, "b.ts"), "b");
    commitAll(repo, "side");
    git(repo, ["checkout", "--quiet", "main"]);
    assert.deepEqual(observed(repo, there, started).made, [git(repo, ["rev-parse", "side"])]);
  });

  test("was there when it was committed before the turn started, as one a fetch brought", () => {
    const there = thereOf(repo);
    const start = head();
    writeFileSync(join(repo, "b.ts"), "b");
    commitAll(repo, "fetched");
    assert.deepEqual(observed(repo, there, LATER).made, []);
    assert.deepEqual(movedSince(repo, { head: start, at: LATER }, there), {
      under: [head()],
      to: head(),
      arrived: true,
    });
  });

  test("stays one the session made in the turns after, once a stop saw it as its own", () => {
    const there = thereOf(repo);
    const start = head();
    writeFileSync(join(repo, "b.ts"), "b");
    commitAll(repo, "agent");
    const seen = observed(repo, there, Date.now() - 1000);
    assert.equal(movedSince(repo, { head: start, at: LATER }, seen), undefined);
  });
});

describe("what a session knows of a repo", () => {
  test("still gains the commits of the turn at the stop where it loses a commit git no longer has", () => {
    const there = { known: [head(), "1".repeat(40)], made: [] };
    writeFileSync(join(repo, "b.ts"), "b");
    commitAll(repo, "agent");
    assert.deepEqual(observed(repo, there, Date.now() - 1000).made, [head()]);
  });

  test("loses the commits git no longer has, where it would otherwise tell nothing any more", () => {
    const gone = "1".repeat(40);
    const there = { known: [head(), gone], made: [] };
    assert.deepEqual(observed(repo, there, Date.now()).known, [head()]);
  });
});
