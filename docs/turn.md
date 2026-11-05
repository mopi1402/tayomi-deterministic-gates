# How a turn is checked, in detail

The README gives the four steps. This page holds what the engine does around them, for whoever needs to know.

## The turn start

When a prompt arrives, the engine records the working tree as a commit that no branch points to, untracked files included and ignored files left out. The commit lives among the loose objects of `.git` until git prunes it, like any object nothing points to. If git pruned it before the stop, the turn is checked from the last commit instead, with the gates and the reports it started with, and the summary says so.

Each compared gate then runs on the whole project, unless its report for that very tree is known from the last check of the repo: the first prompt of a session pays for it, the next ones mostly do not.

A turn you interrupt never reaches its check. The next turn of the repo starts where it did, so its check also covers what the interrupted one changed.

A turn with no recorded start, as the first stop after the hooks are installed, is checked from the last commit, in the repo of the folder the agent stops in, with the gates of now. A compared gate then has no report to compare with and counts only its exit code: the summary says so.

## The files of the turn

A deleted file counts as changed, so a gate that reads the whole project runs on it. It is never named, though: a gate given `{files}` looks at the files left, and is skipped when none is left.

`{files}` is an argument of its own and expands to the changed files the gate looks at. `{turn}` expands, wherever it stands in an argument, to the commit that holds the tree as the turn started. `{engine}/` only ever starts the first word of `run`.

A gate runs from the root of the repo, with colour turned off. Its report is cut to the first and last lines past 4000 characters, with the root path left out.

## The compared gates

A compared gate fails on the lines of output the turn added: the lines its start report does not hold as they are, so a problem that moves to another line or is reworded counts as new too. The lines stay new in the next turns until they are fixed: a report the agent leaves failing is not the next turn's baseline.

The command exits with 0 when it finds problems, as `knip --no-exit-code` or `gofmt -l` do. Any other exit code fails the gate, even when it printed the same thing as the turn started.

## The retry

The agent is sent back once. The engine tells a retry by the flag the agent sends with its stop, so when another Stop hook of yours sends the agent back first, the engine takes its next check for the retry and sends nobody back.

## What the engine keeps

The engine keeps what it knows in the temporary folder of the system: the turn of each session, and the last reports of each repo. It writes nothing in the repo, and the folder is the system's to clean.

## What the lock covers

A turn is checked with the gates as it started: an agent that edits `.gates.json` or `.gates.local.json` mid-turn changes the next turn, never its own, and the summary says so. This covers the two gates files alone. The configuration of a tool, such as `tsconfig.json` or `eslint.config.js`, is read as it is when the gate runs, and only the conduct the agent is told keeps it from weakening one.

## The whole check

`node src/cli.ts check` runs every gate on every file of the repo that matches, committed or not, as if one turn had written it all: a compared gate counts every line of its report. The summary and the failed reports print. The command exits with 1 when a gate fails, and with 2 when it cannot run: outside git, without a gates file, or with one it cannot read.

It shows the state of a repo before its gates are adopted, gives an agent asked to clean a repo up the same reports as the hook, and makes a pre-push hook: the turn pays for what it changed, the push pays for the whole.
