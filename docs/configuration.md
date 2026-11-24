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

| Field             | Meaning                                                                                                                                                                                                             |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`            | Lowercase words joined by hyphens.                                                                                                                                                                                  |
| `severity`        | `error` sends the agent back. `off` never runs. There is no warning, because nobody acts on one.                                                                                                                    |
| `files`           | A regular expression on the repo-relative paths. The gate runs when the turn changed a match, a deleted file included.                                                                                              |
| `run`             | The command, then its arguments. See below.                                                                                                                                                                         |
| `compare`         | `turn-start`: the command runs on the whole project as the turn starts, and only the lines of output the turn added fail the gate. For a tool that exits with 0 when it finds problems.                             |
| `ignoreLines`     | A regular expression for lines of output that never count as new, such as a header with a total.                                                                                                                    |
| `lineKey`         | For a compared gate, a regular expression for the part of a line that tells it apart, when the rest prints otherwise from run to run. See below.                                                                    |
| `timeoutSeconds`  | Less time for this gate than the check has, never more.                                                                                                                                                             |
| `watch`           | A long-running command the gate keeps between turns, judged at the stop instead of `run`. See below.                                                                                                                |
| `prompt`          | A text for the agent, given under the name of the gate when it is red. See [the prompts](#the-prompts-of-the-repo).                                                                                                 |
| `maxReportChars`  | The most characters of its report the agent is sent, for this gate. See [the settings](#the-settings-of-the-whole-check).                                                                                           |
| `omitLines`       | A regular expression for the lines of its report the agent is never sent, such as the frames of a stack: `^\\s+at `. It changes no verdict, and a report it would empty is sent whole.                              |
| `brokenExitCodes` | The exit codes of its command that mean it broke rather than found a problem, as `[2]` for ESLint: the agent is then told to repair the gate, not the code. A compared gate needs none: it broke on any code but 0. |

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
    "failed": "^FAIL ",
    "sync": "src/main.ts"
  }
}
```

| Field        | Meaning                                                                                                          |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| `run`        | The watch command, found as a gate's `run` is. It outlives the turn, so it takes neither `{files}` nor `{turn}`. |
| `cycleStart` | A regular expression on a line of output that opens a cycle: the watch reacting to a change.                     |
| `cycleEnd`   | A regular expression on a line that closes the cycle.                                                            |
| `failed`     | A regular expression on a line that makes the cycle fail. A compared gate takes none.                            |
| `sync`       | A file of the repo the watch opens a cycle for each time its date changes, such as a source file it reads.       |
| `frozen`     | Optional. A regular expression on the files the watch lists only as it starts, such as the specs of `ng test`.   |

As a session starts or a prompt arrives, the engine starts the watch in the background when it does not run yet, one per repo and gate, shared by every session of the repo. It stops once the last session that used it ends, or after 30 minutes without a prompt nor a stop on its repo. A watch that stopped on its own fails the gate with the last lines it printed, and the next prompt starts it again. One that was never started, or that stopped for idleness during a long turn, starts at the stop, which waits for it. The start of the watch opens the first cycle, and a cycle holds every line printed until the next one opens, the lines after its closing line included, such as the errors a failed build prints after saying it failed.

When the agent stops after changing a file the gate looks at, the engine never guesses what the watch has read: it asks the watch for a cycle, and judges only a cycle the watch opened after being asked. To ask, it gives the `sync` file its date again, which changes neither its content nor what git sees, and waits for the watch to open a cycle. It does so in rounds, each once the cycle before it has closed:

1. `sync` alone. The cycle that follows proves the watch now looks for changes: a watch may do so only once its first cycle is over, as Angular and tsc do, and never see a change made while it built. The files of the turn wait for that proof, since a cycle the watch opens for a change of another gate or session would otherwise answer for a touch it missed.
2. The files of the turn that the gate looks at, so that a change the watch missed reaches it, then `sync`.
3. `sync` again: the cycle of round 2 may have been on its way before the files were touched, and this one opens after every change the watch then had waiting. It is the cycle that judges.
4. `sync` once more, since the cycle it opens ends the one of round 3, whose last lines may come after the line that closes it.

A watch that opens no cycle within 1 s of a touch is touched again, then after 2 s, 4 s and so on. One that has opened none after five touches does not look at its `sync` file, and fails the gate saying so: not every watch rebuilds for the file one expects, and Angular 21 does not for a tsconfig, where Angular 22 does. The gate is otherwise red with the lines of the judged cycle when one matches `failed`, green otherwise. A watch that does not answer within the time of the gate shows out of time, never green: no older cycle judges the turn. The watch then owes a cycle for the files of that turn: the next stop it answers touches them again with its own, so a change it missed does not stay unseen until the file changes again. A `sync` file that does not exist fails the gate.

A watch may list some files once, as it starts, and never learn of one created or deleted since: `ng test` does with its specs. `frozen` names them: when the files of the repo that match it are no longer the ones there were as the watch started, the engine starts the watch again before it asks, and its first cycle reads every file there is.

A gate with `compare` judges its watch the same way, on the lines added: at the prompt, the engine asks the watch for a cycle the same way, waits up to 45 s for it, and keeps it as the report of the turn start, and at the stop, the lines of the judged cycle that report lacks fail the gate. The `no-new-strict-errors` gate of the TypeScript catalog does this with `tsc --watch`.

`check`, so CI, never starts a watch: it runs the gate's own `run`, once.

## The settings of the whole check

Next to `gates`, a gates file may set these, and a value in `.gates.local.json` wins:

| Setting               | Default | Meaning                                                                                                                                                                                                                                                                                                                                    |
| --------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `maxTimeoutSeconds`   | `45`    | The time the gates of a check have, all together. A gate still running then is stopped: it shows out of time, neither green nor red, and never sends the agent back. A slower check belongs in CI. An Angular project of a thousand specs takes about 50 s to rebuild and test a change many files import: give it `90`.                   |
| `maxSendBacks`        | `5`     | The most times a turn sends the agent back, `0` never. Past it, the agent hands back and the summary says why.                                                                                                                                                                                                                             |
| `showAllPasses`       | `false` | `true` names every green gate, six to a line, where the summary names the six slowest and counts the rest, as in `... +5`.                                                                                                                                                                                                                 |
| `maxReportChars`      | `4000`  | The most characters of the report of a gate the agent is sent. A longer report keeps its start and its end, cut between two lines when its lines are short enough, with the count of the lines cut. A gate sets its own with the same field, such as less for a list of clones. More than `maxTotalReportChars` needs that one raised too. |
| `maxTotalReportChars` | `4000`  | The most characters the reports of a send-back hold, all gates together. Past it, a short report stays whole and the long ones share the rest alike.                                                                                                                                                                                       |

## The prompts of the repo

What the engine tells the agent has a default, and a repo words it again without waiting for a release. A prompt is a text, added after the default, or `{ "replace": "a text" }`, said in its place:

```json
{
  "prompts": {
    "sendBack": "Never edit a file under src/generated/."
  },
  "gates": [
    {
      "name": "no-new-clones",
      "severity": "error",
      "files": "\\.(ts|tsx)$",
      "run": ["{engine}/src/helpers/new-clones.ts", "{turn}"],
      "prompt": { "replace": "New clones: factor out when both sides are yours, else waive and name the file." }
    }
  ]
}
```

| Prompt                 | When the agent reads it              | Its default                                                                  |
| ---------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `prompts.sendBack`     | Each time it is sent back            | Fix the code, never the check, and when a gate may stay red.                 |
| `prompts.missingTools` | When a gate misses a tool            | Install the tools, or say so and go on.                                      |
| `prompts.brokenGate`   | With the report of a gate that broke | Repair what stops the gate from running, then fix what it reports.           |
| `prompt` of a gate     | When that gate is red                | The line a helper of the engine heads its report with, such as `New clones`. |

The agent reads `prompts.sendBack` whole at the first send-back of a session in the repo, and one line stands for it at the next ones, until the session starts again or compacts. How to waive a gate is always said, whatever replaces `sendBack`: without it, the agent could only loop on a gate it cannot fix. The `run` of a gate whose prompt is replaced gets `GATES_PROMPT_REPLACED=1`, which the helpers of the engine read to leave their own line out, and a script of the repo may do the same. Its watch does not get it. A prompt in `.gates.local.json` wins over the one of `.gates.json`.

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives, such as `{ "name": "typecheck", "timeoutSeconds": 20 }`. Any other local entry adds a gate.
