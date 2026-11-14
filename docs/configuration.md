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
| `timeoutSeconds` | Less time for this gate than the check has, never more.                                                                                                                                 |

## How `run` finds its program

The first word of `run` is looked up in this order, so a gate can run Node, Python, Go or any other program:

1. a script of this engine under `{engine}/`, such as `{engine}/src/helpers/new-clones.ts`;
2. a script of the repo by its path, run on the interpreter of its extension: `.ts`, `.js` and `.mjs` on Node, `.py` on `python3`;
3. a package of the repo's `node_modules`, run through its command, such as `eslint`;
4. a program: by its path in the repo, such as `.venv/bin/ruff`, or by its name on the `PATH`, such as `go`, `gofmt` or `ruff`.

A tool the repo pins beats one on the `PATH`, so write the pinned form when there is one, such as `["uv", "run", "ruff", ...]`. A gate whose program is not installed never runs, and the other gates still do. As a prompt arrives, the agent is asked to install the tool and you are told which gates are off. It is asked once, and again only when the list of missing tools changes or the session starts again.

In the arguments, `{files}` expands to the changed files the gate looks at, and `{turn}` to the commit that holds the tree as the turn started.

A gate whose entry is wrong, such as with an unknown field, is left out and named in the summary, and the other gates still run.

## The settings of the whole check

Next to `gates`, a gates file may set these, and a value in `.gates.local.json` wins:

| Setting             | Default | Meaning                                                                                                                                                                                            |
| ------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `maxTimeoutSeconds` | `45`    | The time the gates of a check have, all together. A gate still running then is stopped: it shows out of time, neither green nor red, and never sends the agent back. A slower check belongs in CI. |
| `maxSendBacks`      | `5`     | The most times a turn sends the agent back, `0` never. Past it, the agent hands back and the summary says why.                                                                                     |
| `showAllPasses`     | `false` | `true` names every green gate, six to a line, where the summary names the six slowest and counts the rest, as in `... +5`.                                                                         |

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives, such as `{ "name": "typecheck", "timeoutSeconds": 20 }`. Any other local entry adds a gate.
