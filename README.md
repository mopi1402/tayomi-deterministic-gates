<p align="center"> <img src="docs/images/tayomi-deterministic-gates.png" alt="deterministic-gates" width="220"/> </p>

# deterministic-gates

Deterministic backpressure for coding agents. At the end of each turn, the gates run on what the agent changed. A gate is a tool, never a model: a linter, a type checker, the related tests, a dead-code finder. If a gate fails, the agent is sent back once with the report, while the context is fresh.

CI stays the authority for slow and full checks. The gates catch what the agent just wrote, so the review sees what slipped through.

## Install

The engine works with any agent that speaks the hook protocol Claude Code and Codex share: one hook runs as a session starts, one as a prompt arrives, another as the agent stops. It needs Node 24.2 or later, has no runtime dependency, and does nothing outside git or in a repo with no gates file.

### Claude Code

```
/plugin marketplace add mopi1402/tayomi-deterministic-gates
/plugin install deterministic-gates@tayomi-deterministic-gates
```

To enable it for one repo only, declare the marketplace and the plugin in that repo's `.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "tayomi-deterministic-gates": {
      "source": { "source": "github", "repo": "mopi1402/tayomi-deterministic-gates" }
    }
  },
  "enabledPlugins": { "deterministic-gates@tayomi-deterministic-gates": true }
}
```

### Codex

```
codex plugin marketplace add mopi1402/tayomi-deterministic-gates
codex plugin add deterministic-gates@tayomi-deterministic-gates
```

Codex runs no hook you have not reviewed: in a session, open `/hooks` and trust the three hooks of the plugin. A plugin update that changes a script asks for a new review.

## Configure the gates

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

| Field            | Meaning                                                                                                                                                                                 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`           | Lowercase words joined by hyphens.                                                                                                                                                      |
| `severity`       | `error` sends the agent back. `off` never runs. There is no warning, because nobody acts on one.                                                                                        |
| `files`          | A regular expression on the repo-relative paths. The gate runs when the turn changed a match, a deleted file included.                                                                  |
| `run`            | The command, then its arguments. See below.                                                                                                                                             |
| `compare`        | `turn-start`: the command runs on the whole project as the turn starts, and only the lines of output the turn added fail the gate. For a tool that exits with 0 when it finds problems. |
| `ignoreLines`    | A regular expression for lines of output that never count as new, such as a header with a total.                                                                                        |
| `timeoutSeconds` | Less time for this gate than the check has, never more.                                                                                                                                 |

The first word of `run` is looked up in this order, so a gate can run Node, Python, Go or any other program:

1. a script of this engine under `{engine}/`, such as `{engine}/src/helpers/new-clones.ts`;
2. a script of the repo by its path, run on the interpreter of its extension: `.ts`, `.js` and `.mjs` on Node, `.py` on `python3`;
3. a package of the repo's `node_modules`, run through its command, such as `eslint`;
4. a program: by its path in the repo, such as `.venv/bin/ruff`, or by its name on the `PATH`, such as `go`, `gofmt` or `ruff`.

A tool the repo pins beats one on the `PATH`, so write the pinned form when there is one, such as `["uv", "run", "ruff", ...]`. A gate whose program is not installed never runs, and the other gates still do. As a prompt arrives, the agent is asked to install the tool and you are told which gates are off. It is asked once, and again only when the list of missing tools changes or the session starts again.

A gate whose entry is wrong, such as with an unknown field, is left out and named in the summary, and the other gates still run.

Next to `gates`, `maxTimeoutSeconds` is the time the gates of a check have, all together: 45 seconds by default. They start at once, and a gate still running then is stopped. It shows out of time, neither green nor red, and never sends the agent back, since nobody knows what it would have said. A slower check belongs in CI.

The summary names the six slowest green gates and counts the rest, as in `... +5`. Set `"showAllPasses": true` next to `gates` to name every one of them, six to a line. A value in `.gates.local.json` wins, so each developer can choose for themselves.

In the arguments, `{files}` expands to the changed files the gate looks at, and `{turn}` to the commit that holds the tree as the turn started.

## Pick gates from the catalog

`catalog/` lists the gates worth copying into a repo, one file per technology, each entry with what the gate catches and the tools it requires; `catalog/index.html` is the same content as a page. The engine reads only `.gates.json`: copy a gate there, install what it requires, and adapt its `files` to the layout of the repo.

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives, such as `{ "name": "typecheck", "timeoutSeconds": 20 }`. Any other local entry adds a gate.

## How a turn is checked

1. When a prompt arrives, the engine records the working tree as a commit that no branch points to, without touching the index, the files or any branch.
2. When the agent stops, it records the tree again and lists the files the turn changed.
3. Each gate with a matching file runs, all of them in parallel, with the gates as the turn started.
4. If a gate fails, the agent is sent back once with the reports, told to fix the code and never the check, and to hand back if a report contradicts what it was asked. If it stops again with a gate still failing, only you are told: no loop.

[docs/turn.md](docs/turn.md) draws the rest: where the start comes from, how a compared gate reads its report, what the engine keeps between turns, and what the lock covers.

To check the whole repo, as before adopting the gates or in a pre-push hook:

```
node src/cli.ts check
```

Every gate runs on every file that matches, and the command exits with 1 when a gate fails.

## Develop

```
pnpm install --frozen-lockfile
pnpm check
pnpm integration
```

This repo runs under its own gates, in its `.gates.json`, and no gate runs a whole test suite at the end of a turn: that is what `pnpm check`, `pnpm integration` and `node src/cli.ts check` are for.

`integration/` holds a sample project per catalog. The integration tests play an agent's turn on each, with no agent and no model: a clean change passes every gate, and each gate catches the fault written for it. To add a gate to a catalog, edit its file, write its fault, and run `pnpm catalog` to regenerate the page.

## License

MIT
