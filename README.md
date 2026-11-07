<p align="center"> <img src="docs/images/tayomi-deterministic-gates.png" alt="deterministic-gates" width="220"/> </p>

# deterministic-gates

Deterministic backpressure for coding agents. At the end of each turn, the gates run on what the agent changed. A gate is a tool, never a model: a linter, a type checker, the related tests, a dead-code finder. If a gate fails, the agent is sent back once with the report, while the context is fresh.

CI stays the authority for slow and full checks. The gates catch what the agent just wrote, so the review sees what slipped through.

## Install

The engine works with any agent that speaks the hook protocol Claude Code and Codex share: one hook runs as a prompt arrives, another as the agent stops. It needs Node 24.2 or later, has no runtime dependency, and does nothing outside git or in a repo with no gates file.

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

Codex runs no hook you have not reviewed: in a session, open `/hooks` and trust the two hooks of the plugin. A plugin update that changes a script asks for a new review.

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
| `timeoutSeconds` | 30 by default, 60 at most. A slower check belongs in CI.                                                                                                                                |

The first word of `run` is looked up in this order, so a gate can run Node, Python, Go or any other program:

1. a script of this engine under `{engine}/`, such as `{engine}/src/helpers/new-clones.ts`;
2. a script of the repo by its path, run on the interpreter of its extension: `.ts`, `.js` and `.mjs` on Node, `.py` on `python3`;
3. a package of the repo's `node_modules`, run through its command, such as `eslint`;
4. a program: by its path in the repo, such as `.venv/bin/ruff`, or by its name on the `PATH`, such as `go`, `gofmt` or `ruff`.

A tool the repo pins beats one on the `PATH`, so write the pinned form when there is one, such as `["uv", "run", "ruff", ...]`. A gate whose program is not installed fails with a message that says so, and the other gates still report.

In the arguments, `{files}` expands to the changed files the gate looks at, and `{turn}` to the commit that holds the tree as the turn started.

## Pick gates from the catalog

`catalog/` lists the gates worth copying into a repo, one file per technology, each entry with what the gate catches and the tools it requires; `catalog/index.html` is the same content as a page. The engine reads only `.gates.json`: copy a gate there, install what it requires, and adapt its `files` to the layout of the repo.

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives, such as `{ "name": "typecheck", "timeoutSeconds": 45 }`. Any other local entry adds a gate.

## How a turn is checked

1. When a prompt arrives, the engine records the working tree as a commit that no branch points to. It changes neither the index, nor the files, nor any branch.
2. When the agent stops, the engine records the tree again and lists the files the turn changed.
3. Each gate with a matching file runs, all of them in parallel, with the gates as the turn started: an agent that edits `.gates.json` mid-turn changes the next turn, never its own.
4. If a gate fails, the agent is sent back once with the reports, told to fix the code and never the check, and to hand back and say so if a report is wrong. If it stops again with a gate still failing, only you are told, so a gate the agent cannot satisfy never loops.

A turn you interrupt is checked with the next turn of its repo, in the repo it started in, whatever folder the agent stops in. [docs/turn.md](docs/turn.md) has the rest: what a turn with no recorded start gets, how a compared gate reads its report, what the engine keeps between turns, and what the lock covers.

To check the whole repo, as before adopting the gates or in a pre-push hook:

```
node src/cli.ts check
```

Every gate runs on every file that matches, as if one turn had written it all, and the command exits with 1 when a gate fails.

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
