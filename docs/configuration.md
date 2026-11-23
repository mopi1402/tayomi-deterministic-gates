# Configure the gates

The gates of a repo live in `.gates.json` at its root, committed. Each one names a command, and the files that make it run:

```json
{
  "gates": [
    {
      "name": "lint",
      "severity": "error",
      "files": "\\.(ts|tsx)$",
      "run": ["eslint", "--max-warnings", "0", "--no-warn-ignored", "{files}"]
    }
  ]
}
```

## The fields of a gate

| Field            | Meaning                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | Lowercase words joined by hyphens.                                                                                                                                                      |
| `severity`       | `error` sends the agent back. `off` never runs. There is no warning, because nobody acts on one.                                                                                        |
| `files`          | A regular expression on the repo-relative paths. The gate runs when the turn changed a match, a deleted file included.                                                                  |
| `run`            | The command, then its arguments. See below.                                                                                                                                             |
| `compare`        | `turn-start`: the command runs on the whole project as the turn starts, and only the lines of output the turn added fail the gate. For a tool that exits with 0 when it finds problems. |
| `ignoreLines`    | A regular expression for lines of output that never count as new, such as a header with a total.                                                                                        |
| `lineKey`        | For a compared gate, a regular expression for the part of a line that tells it apart, when the rest prints otherwise from run to run. See below.                                        |
| `timeoutSeconds` | Less time for this gate than the check has, never more.                                                                                                                                 |
| `watch`          | A long-running command the gate keeps between turns, judged at the stop instead of `run`. See below.                                                                                    |

## A compared gate whose lines print otherwise

Some tools print the same problem otherwise from one run to the next: tsc writes the types of a message in the order it happened to create them. `lineKey` names the part of a line that tells the problem apart, and the rest is for the agent alone. A line is new when no line of the turn start had its key, unless a line of the turn start whose key went stands for it, each one for a single line:

1. one that says the same: that problem is reported elsewhere, unless the key has a group named `file` that names a file the turn changed, where the agent may have written it;
2. then, when the key has a group, one whose first group is the same: that problem changed where it is.

`no-new-strict-errors` prints its key, the file, code and source line of an error, before a tab, and the message after it. Its `lineKey` is `^((?<file>.+?): error TS\d+) at [^\t]*`, whose first group is the file and code: an error on a line the turn changed stays old as long as its file has no more errors of its code than at the turn start.

## How `run` finds its program

The first word of `run` is looked up in this order, so a gate can run Node, Python, Go or any other program:

1. a script of this engine under `{engine}/`, such as `{engine}/src/helpers/new-clones.ts`;
2. a script of the repo by its path, run on the interpreter of its extension: `.ts`, `.js` and `.mjs` on Node, `.py` on `python3`;
3. a package of the repo's `node_modules`, run through its command on Node, such as `eslint`;
4. a program: by its path in the repo, such as `.venv/bin/ruff`, or by its name on the `PATH`, such as `go`, `gofmt` or `ruff`.

Node is the one the repo pins as a package, in `node_modules/.bin`, as npx finds it, or else the one running the engine. A tool runs with `node_modules/.bin` first on its `PATH`, so the programs it starts find the same. A tool the repo pins beats one on the `PATH`, so write the pinned form when there is one, such as `["uv", "run", "ruff", ...]`. A gate whose program is not installed never runs, and the other gates still do. As a prompt arrives, the agent is asked to install the tool and you are told which gates are off. It is asked once, and again only when the list of missing tools changes or the session starts again.

In the arguments, `{files}` expands to the changed files the gate looks at, and `{turn}` to the commit that holds the tree as the turn started.

A gate whose entry is wrong, such as with an unknown field, is left out and named in the summary, and the other gates still run.

## A gate that keeps a watch

Some tools cost too much to start at every stop, such as `ng test`, which builds the whole application before a single test runs. Their watch mode keeps the build warm and reruns only what a change touches. A gate can keep that watch:

```json
{
  "name": "tests",
  "severity": "error",
  "files": "\\.ts$",
  "run": ["my-runner", "test"],
  "watch": {
    "run": ["my-runner", "test", "--watch"],
    "cycleStart": "^Change detected",
    "cycleEnd": "^Tests done",
    "failed": "^FAIL "
  }
}
```

| Field        | Meaning                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `run`        | The watch command, found as a gate's `run` is. It outlives the turn, so it takes neither `{files}` nor `{turn}`. |
| `cycleStart` | A regular expression on a line of output that opens a cycle: the watch reacting to a change.                     |
| `cycleEnd`   | A regular expression on a line that closes the cycle.                                                            |
| `failed`     | A regular expression on a line that makes the cycle fail. A compared gate takes none.                            |

As a session starts or a prompt arrives, the engine starts the watch in the background when it does not run yet, one per repo and gate, shared by every session of the repo. It stops once the last session that used it ends, or after 30 minutes without a prompt nor a stop on its repo. A watch that stopped on its own fails the gate with the last lines it printed, and the next prompt starts it again. One that was never started, or that stopped for idleness during a long turn, starts at the stop, which waits for it. The start of the watch opens the first cycle, and a cycle holds every line printed since it opened, the lines after its closing line included, such as the errors a failed build prints after saying it failed.

When the agent stops after changing a file the gate looks at, the engine waits until the watch has settled: a cycle started after the last change to a file of the turn that the gate looks at, so it read that change however long the watch took to see it, that cycle closed, and 1 s with no new output, for the lines a watch prints after a cycle closes. A change no cycle started after within 5 s is one the watch does not look at, such as a spec its build leaves out, and the last cycle judges the turn. It then judges the turn on the last cycle: red with its lines when one matches `failed`, green otherwise. A watch that does not settle within the time of the gate shows out of time.

A gate with `compare` judges its watch the same way, on the lines added: at the prompt, the engine waits up to 45 s for the watch to settle and keeps its last cycle as the report of the turn start, and at the stop, the lines of the last cycle that report lacks fail the gate. The `no-new-strict-errors` gate of the TypeScript catalog does this with `tsc --watch`.

`check`, so CI, never starts a watch: it runs the gate's own `run`, once.

## The settings of the whole check

Next to `gates`, a gates file may set these, and a value in `.gates.local.json` wins:

| Setting             | Default | Meaning                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxTimeoutSeconds` | `45`    | The time the gates of a check have, all together. A gate still running then is stopped: it shows out of time, neither green nor red, and never sends the agent back. A slower check belongs in CI. An Angular project of a thousand specs takes about 50 s to rebuild and test a change many files import: give it `90`. |
| `maxSendBacks`      | `5`     | The most times a turn sends the agent back, `0` never. Past it, the agent hands back and the summary says why.                                                                                                                                                                                                           |
| `showAllPasses`     | `false` | `true` names every green gate, six to a line, where the summary names the six slowest and counts the rest, as in `... +5`.                                                                                                                                                                                               |

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives, such as `{ "name": "typecheck", "timeoutSeconds": 20 }`. Any other local entry adds a gate.
