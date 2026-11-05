# deterministic-gates

Deterministic backpressure for coding agents. At the end of each turn, the gates run on what the agent changed. A gate is a tool, never a model: a linter, a type checker, the related tests, a dead-code finder. If a gate fails, the agent is sent back once with the report, while the context is fresh.

CI stays the authority for slow and full checks. The gates catch what the agent just wrote, so the review sees what slipped through.

## Install

The engine works with any agent that speaks the hook protocol Claude Code and Codex share: one hook runs as a prompt arrives, another as the agent stops. Both hooks call the engine the same way:

```
node src/cli.ts hook turn-start
node src/cli.ts hook check
```

The engine needs Node 24.2 or later. It has no runtime dependency. It does nothing outside git, or in a repo with no gates file.

### Claude Code

```
/plugin marketplace add mopi1402/tayomi-deterministic-gates
/plugin install deterministic-gates@tayomi-deterministic-gates
```

To enable it for one repo only, add the marketplace and the plugin to that repo's `.claude/settings.json`:

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

Codex installs the plugin, but does not run the hooks a plugin bundles yet ([openai/codex#16430](https://github.com/openai/codex/issues/16430)). Until it does, clone this repo and declare the two hooks in `~/.codex/hooks.json`, or in the `.codex/hooks.json` of one repo. Codex runs no hook you have not reviewed: trust them with `/hooks`.

```json
{
  "hooks": {
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/tayomi-deterministic-gates/src/cli.ts hook turn-start",
            "timeout": 60
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/tayomi-deterministic-gates/src/cli.ts hook check",
            "timeout": 300
          }
        ]
      }
    ]
  }
}
```

## Configure the gates

The gates of a repo live in `.gates.json` at its root, committed:

```json
{
  "gates": [
    {
      "name": "lint",
      "severity": "error",
      "files": "\\.(ts|tsx)$",
      "run": ["eslint", "--max-warnings", "0", "--no-warn-ignored", "{files}"]
    },
    {
      "name": "typecheck",
      "severity": "error",
      "files": "(\\.(ts|tsx)|^(tsconfig|package|package-lock)\\.json)$",
      "run": [
        "typescript",
        "--pretty",
        "false",
        "--incremental",
        "--tsBuildInfoFile",
        "node_modules/.cache/gates/tsbuildinfo"
      ]
    },
    {
      "name": "no-new-dead-code",
      "severity": "error",
      "files": "^(src/.*\\.(ts|tsx)|[^/]+\\.(json|ts|mjs))$",
      "run": ["knip", "--reporter", "compact", "--no-exit-code", "--no-progress"],
      "compare": "turn-start",
      "ignoreLines": "\\(\\d+\\)$"
    },
    {
      "name": "no-new-clones",
      "severity": "error",
      "files": "^src/.*\\.(ts|tsx)$",
      "run": ["{engine}/src/helpers/new-clones.ts", "{turn}"]
    }
  ]
}
```

| Field            | Meaning                                                                                                                                                                                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `name`           | Lowercase words joined by hyphens.                                                                                                                                                                                                                           |
| `severity`       | `error` sends the agent back. `off` never runs. There is no warning, because nobody acts on one.                                                                                                                                                             |
| `files`          | A regular expression on the repo-relative paths. The gate runs only when the turn changed a match, a deleted file included: a gate given `{files}` looks at the files left, and is skipped when none is left.                                                |
| `run`            | The command, then its arguments. See below.                                                                                                                                                                                                                  |
| `compare`        | `turn-start`: the command also runs as the turn starts, and only the lines of output the turn added fail the gate, and stay new in the next turns until they are fixed. The command exits with 0 when it finds problems. Any other exit code fails the gate. |
| `ignoreLines`    | A regular expression for lines of output that never count as new, such as a header with a total.                                                                                                                                                             |
| `timeoutSeconds` | 30 by default, 60 at most. A slower check belongs in CI.                                                                                                                                                                                                     |

The first word of `run` is looked up in this order, so a gate can run Node, Python, Go or any other program:

1. a script of this engine under `{engine}/`, such as `{engine}/src/helpers/new-clones.ts`;
2. a script of the repo by its path, run on the interpreter of its extension: `.ts`, `.js` and `.mjs` on Node, `.py` on `python3`;
3. a package of the repo's `node_modules`, run through its command, such as `eslint`;
4. a program: by its path in the repo, such as `.venv/bin/ruff`, or by its name on the `PATH`, such as `go`, `gofmt` or `ruff`.

A tool the repo pins beats one on the `PATH`, so write the pinned form when there is one, such as `["uv", "run", "ruff", ...]`. A gate whose program is not installed fails with a message that says so, and the other gates still report.

In the arguments, `{files}` expands to the changed files the gate looks at, and `{turn}` to the commit that holds the tree as the turn started.

## Pick gates from the catalog

`catalog/` lists the gates worth copying into a repo, one file per technology: `typescript.json`, `go.json` and `python.json`. Each entry says what the gate catches and which tools it requires. These files are the source of truth an agent reads to know what to propose for a repo, and `catalog/index.html` is the same content as a page to browse.

The catalog never runs by itself: the engine reads only `.gates.json`. Copy the definition of a gate there, install what it requires, and adapt its `files` to the layout of the repo.

To add a gate, edit the file of its technology, then run `pnpm catalog` to regenerate the page. A test fails while the page and the files disagree, and while an entry is not a gate the engine accepts. The integration tests fail while a gate of the catalog has no fault written for it.

## Override the gates for yourself

Each developer can add `.gates.local.json` next to `.gates.json`, and add it to `.gitignore`. A local entry with the name of a shared gate changes only the fields it gives:

```json
{ "gates": [{ "name": "typecheck", "timeoutSeconds": 45 }] }
```

Any other local entry adds a gate.

## How a turn is checked

1. When a prompt arrives, the engine records the working tree as a commit that no branch points to. It changes neither the index, nor the files, nor the history.
2. When the agent stops, the engine records the tree again and lists the files the turn changed.
3. Each gate with a matching file runs, all of them in parallel.
4. If a gate fails, the agent is sent back once with the reports, told to fix the code and never the check, and told to hand back and say so if a report is wrong. If it stops again with a gate still failing, only you are told, so a gate the agent cannot satisfy never loops.

A turn you interrupt is checked with the next turn of its repo. A turn is checked in the repo it started in, whatever folder the agent stops in; a turn with no recorded start is checked from the last commit, in the repo of that folder.

The hook only ever judges a turn. To check the whole repo, run this from any folder of it:

```
node src/cli.ts check
```

Every gate runs on every file of the repo that matches, committed or not, as if one turn had written it all: a compared gate counts every line of its report. The summary and the failed reports print, and the command exits with 1 when a gate fails. It shows the state of a repo before its gates are adopted, gives an agent asked to clean a repo up the same reports as the hook, and makes a pre-push hook: the turn pays for what it changed, the push pays for the whole.

A turn is checked with the gates as it started: an agent that edits `.gates.json` or `.gates.local.json` mid-turn changes the next turn, never its own, and the summary says so. To change the gates, edit them or have the agent do it: they apply from the next prompt.

## Develop

```
pnpm install --frozen-lockfile
pnpm check
pnpm integration
```

This repo runs under its own gates, in its `.gates.json`: the type check, the format, the unit tests a change reaches, the integration tests when a sample or a catalog changes, and the clones and dead code a turn adds. The dead-code gate is what `pnpm check` misses: it caught its first unused export the day it was added. No gate runs a whole test suite at the end of a turn: that is what `pnpm check`, `pnpm integration` and `node src/cli.ts check` are for.

`integration/` holds a sample project per catalog: `typescript/`, `go/` and `python/`. The integration tests copy each one to a repo of its own with the gates of its catalog, then play an agent's turn with the engine of this folder: they send the events Claude Code and Codex send, write a change in place of the agent, and read the verdict in place of the agent. No agent and no model runs: the tests take seconds and cost no tokens. A clean change passes every gate, and each gate catches the fault written for it. The TypeScript tools come from the pnpm workspace; Go, `gofmt`, `golangci-lint` and `ruff` come from the `PATH`, and a gate whose tool is not installed is skipped by name.

## License

MIT
