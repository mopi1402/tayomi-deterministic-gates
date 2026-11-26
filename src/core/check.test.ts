import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { checkAll, checkTurn, startTurn } from "./check.ts";
import { gatesOf, readGatesFiles } from "./config.ts";
import { cachedReports } from "./report-cache.ts";
import { snapshot } from "./snapshot.ts";
import { readTurn, writeTurn } from "./turn-state.ts";
import { commitAll, git, tempRepo, writeGates } from "../testing.ts";

let repo = "";
let session = "";

const gates = (...list: object[]) => writeGates(repo, ...list);

function cachedNow(): string | undefined {
  const [gate] = gatesOf(readGatesFiles(repo)).gates;
  return gate && cachedReports(repo, snapshot(repo).tree)(gate);
}

beforeEach(() => {
  repo = tempRepo();
  session = `test-${randomUUID()}`;
  gates();
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("a turn the owner interrupts", () => {
  test("is checked with the next turn: the next one starts where it did", async () => {
    await startTurn(session, repo);
    const interrupted = readTurn(session, repo)?.start;
    writeFileSync(join(repo, "written-before-the-interruption.ts"), "1");
    await startTurn(session, repo);
    assert.equal(readTurn(session, repo)?.start, interrupted);
  });

  test("never holds back a turn once a check covered it", async () => {
    await startTurn(session, repo);
    const checked = readTurn(session, repo)?.start;
    writeFileSync(join(repo, "checked.ts"), "1");
    await checkTurn(session, repo);
    await startTurn(session, repo);
    assert.notEqual(readTurn(session, repo)?.start, checked);
    assert.equal(readTurn(session, repo)?.checked, false);
  });
});

describe("a check with no recorded start", () => {
  test("still checks, from the last commit, and says so", async () => {
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /no turn start recorded/);
    assert.equal(readTurn(session, repo)?.checked, true);
  });

  test("says which compared gates had no report to compare with, instead of a silent green", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("old problem")');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /dead not compared: no report from the turn start/);
  });
});

describe("the gates a turn is checked with", () => {
  const failing = { name: "fail", severity: "error", files: "\\.ts$", run: ["fail.mjs"] };

  test("are the ones it started with, even when the turn weakens .gates.json, and the check says so", async () => {
    writeFileSync(join(repo, "fail.mjs"), "process.exit(1)");
    gates(failing);
    await startTurn(session, repo);
    gates();
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.equal(turn.outcomes.find(({ name }) => name === "fail")?.ok, false);
    assert.match(turn.note ?? "", /the turn changed \.gates\.json: checked with the gates as the turn started/);
  });

  test("are the ones it started with, even when the turn turns one off in an ignored .gates.local.json", async () => {
    writeFileSync(join(repo, "fail.mjs"), "process.exit(1)");
    writeFileSync(join(repo, ".gitignore"), ".gates.local.json\n");
    gates(failing);
    await startTurn(session, repo);
    writeFileSync(join(repo, ".gates.local.json"), JSON.stringify({ gates: [{ name: "fail", severity: "off" }] }));
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.equal(turn.outcomes.find(({ name }) => name === "fail")?.ok, false);
    assert.match(turn.note ?? "", /the turn changed \.gates\.local\.json/);
  });
});

describe("a check whose recorded start git no longer has", () => {
  test("checks from the last commit and says so, so the next turns are not held on it", async () => {
    writeTurn(session, repo, {
      start: "0123456789abcdef0123456789abcdef01234567",
      baselines: {},
      config: {},
      checked: false,
    });
    const turn = await checkTurn(session, repo);
    assert.match(turn.note ?? "", /turn start lost/);
    assert.equal(readTurn(session, repo)?.checked, true);
  });
});

describe("a check of the whole repo", () => {
  test("runs each gate on every file of the repo, committed or not, whatever the turn changed", async () => {
    writeFileSync(join(repo, "tool.mjs"), "console.log(process.argv.slice(2).join(' ')); process.exit(1)");
    gates({ name: "list", severity: "error", files: "\\.ts$", run: ["tool.mjs", "{files}"] });
    writeFileSync(join(repo, "committed.ts"), "1");
    commitAll(repo, "old");
    await startTurn(session, repo);
    writeFileSync(join(repo, "new.ts"), "1");
    const all = await checkAll(repo);
    assert.equal(all.outcomes.find(({ name }) => name === "list")?.output, "committed.ts new.ts");
  });

  test("counts every line of a compared gate, not only the ones a turn added", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("old problem")');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    writeFileSync(join(repo, "a.ts"), "1");
    const all = await checkAll(repo);
    assert.deepEqual(
      all.outcomes.map(({ name, ok, output }) => ({ name, ok, output })),
      [{ name: "dead", ok: false, output: "old problem" }],
    );
  });
});

describe("the reports a check leaves for the next turn", () => {
  const cases = [
    { name: "a turn that changed nothing keeps the start report", run: ["tool.mjs"], changed: "", kept: true },
    { name: "a whole-project run keeps its report", run: ["tool.mjs"], changed: "a.ts", kept: true },
    { name: "a gate that did not run keeps none", run: ["tool.mjs"], changed: "tsconfig.json", kept: false },
  ];
  for (const { name, run, changed, kept } of cases) {
    test(name, async () => {
      writeFileSync(join(repo, "tool.mjs"), 'console.log("fine")');
      gates({ name: "dead", severity: "error", files: "\\.ts$", run, compare: "turn-start" });
      await startTurn(session, repo);
      if (changed) writeFileSync(join(repo, changed), "{}");
      await checkTurn(session, repo);
      assert.equal(cachedNow(), kept ? "fine" : undefined);
    });
  }
});

describe("a prompt whose hook is stopped before the reports of its turn start are ready", () => {
  test("has already started its turn: the send-backs of the turn before are gone", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'setTimeout(() => console.log("old"), 300)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    await checkTurn(session, repo);
    const checked = readTurn(session, repo);
    assert.ok(checked);
    writeTurn(session, repo, { ...checked, sendBacks: { count: 2, waivers: {}, reports: {} } });
    writeFileSync(join(repo, "a.ts"), "1");
    const starting = startTurn(session, repo);
    const started = readTurn(session, repo);
    assert.equal(started?.checked, false);
    assert.equal(started?.sendBacks, undefined);
    await starting;
  });
});

describe("a report out of time as the turn started", () => {
  test("is no report: the turn says it has none to compare with, where its lines would all be new", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'setTimeout(() => console.log("old"), 3000)');
    gates({
      name: "dead",
      severity: "error",
      files: "\\.ts$",
      run: ["tool.mjs"],
      compare: "turn-start",
      timeoutSeconds: 1,
    });
    await startTurn(session, repo);
    assert.deepEqual(readTurn(session, repo)?.baselines, {});
  });
});

describe("a report that broke as the turn started", () => {
  test("serves that turn, but is never kept for the next one", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    assert.deepEqual(readTurn(session, repo)?.baselines, { dead: "boom" });
    assert.equal(cachedNow(), undefined);
  });
});

describe("a report that broke as the turn started, after a turn that changed nothing", () => {
  test("is still not kept: the next turn runs the command again", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    await checkTurn(session, repo);
    assert.equal(cachedNow(), undefined);
  });
});

describe("a compared gate whose command breaks", () => {
  test("fails every turn it breaks in, whether it broke as the turn started or since: neither is excused", async () => {
    writeFileSync(join(repo, "tool.mjs"), 'console.log("boom"); process.exit(2)');
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    for (const file of ["a.ts", "b.ts"]) {
      await startTurn(session, repo);
      writeFileSync(join(repo, file), "1");
      const [outcome] = (await checkTurn(session, repo)).outcomes;
      assert.deepEqual([outcome?.ok, outcome?.broken, outcome?.timedOut], [false, true, undefined], file);
    }
  });
});

describe("a compared gate the agent leaves failing", () => {
  test("fails the next turn too: what a turn added stays new until it is fixed", async () => {
    writeFileSync(
      join(repo, "tool.mjs"),
      'import { existsSync } from "node:fs"; console.log("fine"); if (existsSync("a.ts")) console.log("unused a");',
    );
    gates({ name: "dead", severity: "error", files: "\\.ts$", run: ["tool.mjs"], compare: "turn-start" });
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    assert.equal((await checkTurn(session, repo)).outcomes[0]?.output, "unused a");
    await startTurn(session, repo);
    writeFileSync(join(repo, "b.ts"), "1");
    assert.equal((await checkTurn(session, repo)).outcomes[0]?.output, "unused a");
  });
});

describe("a file the turn deleted", () => {
  const print = 'console.log(process.argv.slice(2).join(" ") || "no file")';
  const whole = { name: "whole", severity: "error", files: "\\.ts$", run: ["tool.mjs"] };
  const named = { name: "named", severity: "error", files: "\\.ts$", run: ["tool.mjs", "{files}"] };

  test("runs the gates that look at it, and is never named in {files}", async () => {
    writeFileSync(join(repo, "tool.mjs"), print);
    writeFileSync(join(repo, "a.ts"), "1");
    writeFileSync(join(repo, "b.ts"), "1");
    gates(whole, named);
    await startTurn(session, repo);
    rmSync(join(repo, "a.ts"));
    writeFileSync(join(repo, "b.ts"), "2");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(turn.changed, ["a.ts", "b.ts"]);
    assert.deepEqual(
      turn.outcomes.map(({ name, output }) => [name, output]),
      [
        ["whole", "no file"],
        ["named", "b.ts"],
      ],
    );
  });

  test("skips a gate that would have nothing but deleted files to look at", async () => {
    writeFileSync(join(repo, "tool.mjs"), print);
    writeFileSync(join(repo, "a.ts"), "1");
    gates(whole, named);
    await startTurn(session, repo);
    rmSync(join(repo, "a.ts"));
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name }) => name),
      ["whole"],
    );
    assert.deepEqual(turn.skipped, ["named"]);
  });
});

describe("a gate whose tool this machine does not have", () => {
  const missing = { name: "lint", severity: "error", files: "\\.ts$", run: ["no-such-tool", "{files}"] };
  const present = { name: "true", severity: "error", files: "\\.ts$", run: ["true"] };

  test("is named as the turn starts, with why", async () => {
    gates(missing, present);
    assert.deepEqual(await startTurn(session, repo), [
      "lint: no-such-tool is not installed: it is neither a package of node_modules nor a program on the PATH.",
    ]);
  });

  test("never runs nor fails the turn, and the check names it when the turn concerned it", async () => {
    gates(missing, present);
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name, ok }) => [name, ok]),
      [["true", true]],
    );
    assert.match(turn.note ?? "", /^lint not run: no-such-tool is not installed/m);
  });

  test("is not named when the turn did not concern it", async () => {
    gates(missing, present);
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.md"), "1");
    assert.equal((await checkTurn(session, repo)).note, undefined);
  });
});

describe("a gate with a problem of its own", () => {
  test("is left out and named, while the other gates of the file still run", async () => {
    gates(
      { name: "broken", severity: "error", files: "\\.ts$", run: ["true"], extra: 1 },
      { name: "fine", severity: "error", files: "\\.ts$", run: ["true"] },
    );
    await startTurn(session, repo);
    writeFileSync(join(repo, "a.ts"), "1");
    const turn = await checkTurn(session, repo);
    assert.deepEqual(
      turn.outcomes.map(({ name }) => name),
      ["fine"],
    );
    assert.match(turn.note ?? "", /^broken not run, its entry is wrong: unknown field extra$/m);
  });
});

describe("a turn that moves HEAD to code it did not write", () => {
  const as = ["-c", "user.name=test", "-c", "user.email=test@test.invalid"];
  const judged = async () => {
    const turn = await checkTurn(session, repo);
    return { ...turn, said: Object.fromEntries(turn.outcomes.map(({ name, output }) => [name, output])) };
  };

  // On main, a.ts. On feature, b.ts and c.ts more. The lint gate names the files it is given, and fails.
  beforeEach(() => {
    writeFileSync(join(repo, "lint.mjs"), 'console.log(process.argv.slice(2).join(" ")); process.exit(1)');
    gates({ name: "lint", severity: "error", files: "\\.ts$", run: ["lint.mjs", "{files}"] });
    writeFileSync(join(repo, "a.ts"), "a");
    commitAll(repo, "main");
    git(repo, ["branch", "-M", "main"]);
    git(repo, ["checkout", "--quiet", "-b", "feature"]);
    writeFileSync(join(repo, "b.ts"), "b");
    writeFileSync(join(repo, "c.ts"), "c");
    commitAll(repo, "feature");
    git(repo, ["checkout", "--quiet", "main"]);
  });

  // main and feature each change a.ts their own way, then the turn starts on main.
  const startInConflict = async () => {
    writeFileSync(join(repo, "a.ts"), "a, on main");
    commitAll(repo, "main again");
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "a.ts"), "a, on feature");
    commitAll(repo, "feature again");
    git(repo, ["checkout", "--quiet", "main"]);
    await startTurn(session, repo);
  };

  // A turn commits d.ts on a branch of its own, and ends back on main.
  const leaveOnSide = async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "-b", "side"]);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    git(repo, ["checkout", "--quiet", "main"]);
    await checkTurn(session, repo);
  };

  // The turn commits d.ts on main, then rebases main on feature.
  const commitThenRebase = async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    git(repo, [...as, "rebase", "--quiet", "feature"]);
  };

  test("judges nothing after a checkout alone, and says HEAD moved", async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    const turn = await judged();
    assert.deepEqual([turn.changed, turn.outcomes], [[], []]);
    assert.match(turn.note ?? "", /HEAD moved during the turn to code it did not write/);
  });

  test("judges only the file the turn wrote after a checkout", async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "d.ts"), "d");
    writeFileSync(join(repo, "b.ts"), "b, edited");
    assert.equal((await judged()).said.lint, "b.ts d.ts");
  });

  test("judges a file the turn wrote before a checkout that kept it", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    git(repo, ["checkout", "--quiet", "feature"]);
    assert.equal((await judged()).said.lint, "d.ts");
  });

  test("judges what the agent commits on its branch as before, without a note", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    const turn = await judged();
    assert.equal(turn.said.lint, "d.ts");
    assert.equal(turn.note, undefined);
  });

  test("judges nothing a merge brought, as a pull does", async () => {
    await startTurn(session, repo);
    git(repo, [...as, "merge", "--quiet", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("judges nothing a reset to another commit brought", async () => {
    await startTurn(session, repo);
    git(repo, ["reset", "--quiet", "--hard", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("still judges what the turn committed before a rebase, and nothing the rebase brought", async () => {
    await commitThenRebase();
    assert.equal((await judged()).said.lint, "d.ts");
  });

  test("judges the file of a conflict the turn resolved in a merge, and no other file the merge brought", async () => {
    await startInConflict();
    assert.throws(() => git(repo, [...as, "merge", "--quiet", "feature"]));
    writeFileSync(join(repo, "a.ts"), "a, resolved");
    commitAll(repo, "merge");
    assert.equal((await judged()).said.lint, "a.ts");
  });

  test("judges the file of a conflict the turn resolved in a rebase", async () => {
    await startInConflict();
    assert.throws(() => git(repo, [...as, "rebase", "--quiet", "feature"]));
    writeFileSync(join(repo, "a.ts"), "a, resolved");
    git(repo, ["add", "a.ts"]);
    git(repo, [...as, "-c", "core.editor=true", "rebase", "--continue"]);
    assert.equal((await judged()).said.lint, "a.ts");
  });

  describe("and back to code the turn knows", () => {
    // The gate says whether the commit it is given as the turn start has d.ts.
    beforeEach(() => {
      writeFileSync(
        join(repo, "had.mjs"),
        'import { execFileSync } from "node:child_process"; try { execFileSync("git", ["cat-file", "-e", `${process.argv[2]}:d.ts`], { stdio: "ignore" }); console.log("had d.ts"); } catch { console.log("had no d.ts"); } process.exit(1)',
      );
      gates({ name: "had", severity: "error", files: "\\.ts$", run: ["had.mjs", "{turn}"] });
    });

    test("is a turn as any other when it leaves a branch and comes back, whatever it committed", async () => {
      await startTurn(session, repo);
      writeFileSync(join(repo, "d.ts"), "d");
      commitAll(repo, "agent");
      git(repo, ["checkout", "--quiet", "feature"]);
      git(repo, ["checkout", "--quiet", "main"]);
      const turn = await judged();
      assert.equal(turn.said.had, "had no d.ts");
      assert.equal(turn.note, undefined);
    });

    test("judges what it commits again after a reset to an older commit", async () => {
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      await checkTurn(session, repo);
      await startTurn(session, repo);
      git(repo, ["reset", "--quiet", "--soft", "HEAD~1"]);
      writeFileSync(join(repo, "d.ts"), "d");
      commitAll(repo, "again");
      const turn = await judged();
      assert.deepEqual([turn.said.had, turn.changed], ["had no d.ts", ["d.ts"]]);
    });

    test("gives a gate a turn start without what the turn committed before a rebase", async () => {
      await commitThenRebase();
      assert.equal((await judged()).said.had, "had no d.ts");
    });
  });

  test("judges nothing when it goes back to an older commit of its branch", async () => {
    git(repo, ["checkout", "--quiet", "feature"]);
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "main"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("judges the file of a conflict the turn resolved in a rebase that applies patches", async () => {
    await startInConflict();
    assert.throws(() => git(repo, [...as, "rebase", "--quiet", "--apply", "feature"]));
    writeFileSync(join(repo, "a.ts"), "a, resolved");
    git(repo, ["add", "a.ts"]);
    git(repo, [...as, "rebase", "--continue"]);
    assert.equal((await judged()).said.lint, "a.ts");
  });

  test("judges what it committed in another worktree and merged, with no note", async () => {
    await startTurn(session, repo);
    const side = `${repo}-side`;
    try {
      git(repo, ["worktree", "add", "--quiet", "-b", "side", side]);
      writeFileSync(join(side, "d.ts"), "d");
      commitAll(side, "in a worktree");
      git(repo, [...as, "merge", "--quiet", "side"]);
      const turn = await judged();
      assert.deepEqual([turn.said.lint, turn.note], ["d.ts", undefined]);
    } finally {
      rmSync(side, { recursive: true, force: true });
    }
  });

  test("judges at the turn that brings it back a commit an earlier turn of the session left on another branch", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    git(repo, ["checkout", "--quiet", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "main"]);
    assert.equal((await judged()).said.lint, "d.ts");
  });

  describe("with a remote", () => {
    let remote = "";
    // Before the turn, as a commit someone else pushed.
    const yesterday = { GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z", GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z" };

    beforeEach(() => {
      remote = `${repo}-remote`;
      execFileSync("git", ["init", "--quiet", "--bare", remote]);
      git(repo, ["remote", "add", "origin", remote]);
      git(repo, ["push", "--quiet", "--set-upstream", "origin", "main"]);
    });

    afterEach(() => {
      rmSync(remote, { recursive: true, force: true });
    });

    test("judges what it commits and pushes, with no note", async () => {
      await startTurn(session, repo);
      writeFileSync(join(repo, "d.ts"), "d");
      commitAll(repo, "agent");
      git(repo, ["push", "--quiet", "origin", "main"]);
      const turn = await judged();
      assert.deepEqual([turn.said.lint, turn.note], ["d.ts", undefined]);
    });

    test("judges at the turn that brings it back a commit an earlier turn pushed on another branch", async () => {
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "-b", "mine"]);
      writeFileSync(join(repo, "d.ts"), "d");
      commitAll(repo, "agent");
      git(repo, ["push", "--quiet", "--set-upstream", "origin", "mine"]);
      git(repo, ["checkout", "--quiet", "main"]);
      assert.deepEqual((await judged()).outcomes, []);
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "mine"]);
      assert.equal((await judged()).said.lint, "d.ts");
    });

    test("judges nothing of an older commit fetched with no branch of the remote, as the pull request of a fork", async () => {
      const fork = `${repo}-fork`;
      try {
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, fork]);
        writeFileSync(join(fork, "theirs.ts"), "theirs");
        git(fork, ["add", "--all"]);
        execFileSync("git", [...as, "commit", "--quiet", "-m", "theirs"], {
          cwd: fork,
          env: { ...process.env, ...yesterday },
        });
        await startTurn(session, repo);
        git(repo, ["fetch", "--quiet", fork, "HEAD"]);
        git(repo, ["checkout", "--quiet", "-b", "pr", "FETCH_HEAD"]);
        assert.deepEqual((await judged()).outcomes, []);
      } finally {
        rmSync(fork, { recursive: true, force: true });
      }
    });

    test("judges nothing a pull brought from the remote", async () => {
      const other = `${repo}-other`;
      try {
        execFileSync("git", ["clone", "--quiet", "--branch", "main", remote, other]);
        writeFileSync(join(other, "theirs.ts"), "theirs");
        git(other, ["add", "--all"]);
        execFileSync("git", [...as, "commit", "--quiet", "-m", "theirs"], {
          cwd: other,
          env: { ...process.env, ...yesterday },
        });
        git(other, ["push", "--quiet", "origin", "HEAD:main"]);
        await startTurn(session, repo);
        git(repo, [...as, "pull", "--quiet", "origin", "main"]);
        writeFileSync(join(repo, "d.ts"), "d");
        assert.equal((await judged()).said.lint, "d.ts");
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    });
  });

  test("still judges a commit it left on another branch after a turn of the session in another repo", async () => {
    await leaveOnSide();
    const other = tempRepo();
    try {
      writeGates(other);
      await startTurn(session, other);
      await checkTurn(session, other);
      await startTurn(session, repo);
      git(repo, [...as, "merge", "--quiet", "side"]);
      assert.equal((await judged()).said.lint, "d.ts");
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  test("tells a checkout again once git lost a branch the session knew", async () => {
    git(repo, ["checkout", "--quiet", "-b", "gone"]);
    writeFileSync(join(repo, "gone.ts"), "gone");
    commitAll(repo, "gone");
    git(repo, ["checkout", "--quiet", "main"]);
    await startTurn(session, repo);
    await checkTurn(session, repo);
    git(repo, ["branch", "--quiet", "-D", "gone"]);
    git(repo, ["reflog", "expire", "--expire=now", "--all"]);
    git(repo, ["gc", "--quiet", "--prune=now"]);
    await startTurn(session, repo);
    await checkTurn(session, repo);
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    assert.deepEqual((await judged()).outcomes, []);
  });

  test("judges nothing when it goes back to main from a branch the session committed on in an earlier turn", async () => {
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "-b", "mine"]);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    assert.equal((await judged()).said.lint, "d.ts");
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "main"]);
    const back = await judged();
    assert.deepEqual(back.outcomes, []);
    assert.match(back.note ?? "", /HEAD moved during the turn/);
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "mine"]);
    writeFileSync(join(repo, "e.ts"), "e");
    assert.equal((await judged()).said.lint, "e.ts");
  });

  test("still judges what it committed when the agent stops again after a send-back", async () => {
    await startTurn(session, repo);
    writeFileSync(join(repo, "d.ts"), "d");
    commitAll(repo, "agent");
    assert.equal((await judged()).said.lint, "d.ts");
    assert.equal((await judged()).said.lint, "d.ts");
  });

  test("judges what it committed in the main worktree when a later turn merges it from another worktree", async () => {
    await leaveOnSide();
    const linked = `${repo}-linked`;
    try {
      git(repo, ["worktree", "add", "--quiet", "-b", "linked", linked]);
      await startTurn(session, linked);
      git(linked, [...as, "merge", "--quiet", "side"]);
      const turn = await checkTurn(session, linked);
      assert.equal(turn.outcomes.find(({ name }) => name === "lint")?.output, "d.ts");
    } finally {
      rmSync(linked, { recursive: true, force: true });
    }
  });

  test("gives a gate the commit HEAD moved to as the turn start", async () => {
    writeFileSync(join(repo, "start.mjs"), "console.log(process.argv[2]); process.exit(1)");
    gates({ name: "start", severity: "error", files: "\\.ts$", run: ["start.mjs", "{turn}"] });
    await startTurn(session, repo);
    git(repo, ["checkout", "--quiet", "feature"]);
    writeFileSync(join(repo, "d.ts"), "d");
    assert.equal((await judged()).said.start, git(repo, ["rev-parse", "feature"]));
  });

  describe("with a compared gate", () => {
    const tool =
      'import { readdirSync } from "node:fs"; for (const file of readdirSync(".")) if (file.endsWith(".ts")) console.log(`${file}: unused`)';
    const dead = { name: "dead", severity: "error", files: "\\.ts$", run: ["dead.mjs"], compare: "turn-start" };

    test("counts only the lines that name a file of the turn", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates({ ...dead, lineKey: "^(?<file>[^:]+)" });
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      writeFileSync(join(repo, "d.ts"), "d");
      assert.equal((await judged()).said.dead, "d.ts: unused");
    });

    test("does not compare one whose lines name no file, and says so", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      writeFileSync(join(repo, "d.ts"), "d");
      const turn = await judged();
      assert.equal(turn.outcomes[0]?.ok, true);
      assert.match(turn.note ?? "", /dead not compared: its report of the turn start is of the code HEAD left/);
    });

    test("still compares one whose lines name no file when the turn amends the commit it started on", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      writeFileSync(join(repo, "d.ts"), "d");
      git(repo, ["add", "--all"]);
      git(repo, [...as, "commit", "--quiet", "--amend", "--no-edit"]);
      const turn = await judged();
      assert.deepEqual([turn.said.dead, turn.note], ["d.ts: unused", undefined]);
    });

    test("does not hold the turn to a line that came with the only file a pull brought, which the turn then edited", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      git(repo, [...as, "merge", "--quiet", "feature"]);
      writeFileSync(join(repo, "b.ts"), "b, edited");
      writeFileSync(join(repo, "c.ts"), "c, edited");
      const turn = await judged();
      assert.equal(turn.outcomes[0]?.ok, true);
      assert.match(turn.note ?? "", /dead not compared/);
    });

    test("leaves the next turn a report of the code HEAD moved to", async () => {
      writeFileSync(join(repo, "dead.mjs"), tool);
      gates(dead);
      await startTurn(session, repo);
      git(repo, ["checkout", "--quiet", "feature"]);
      await checkTurn(session, repo);
      await startTurn(session, repo);
      writeFileSync(join(repo, "a.ts"), "a, edited");
      assert.equal((await judged()).outcomes[0]?.ok, true);
    });
  });
});
