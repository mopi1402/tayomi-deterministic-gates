<p align="center"> <img src="docs/images/tayomi-deterministic-gates.png" alt="deterministic-gates" width="220"/> </p>

# deterministic-gates

Deterministic backpressure for coding agents. [At the end of each turn](docs/adr/0001-check-at-the-stop.md), the gates run on what the agent changed. A gate is a tool, never a model: a linter, a type checker, the related tests, a dead-code finder. If a gate fails, the agent is sent back with the report until it fixes the gate or says why it leaves it, while the context is fresh: it still holds what it just wrote, so the fix is cheap, where a review or a CI run finds the same problem once that context is gone.

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

Codex runs no hook you have not reviewed: in a session, open `/hooks` and trust the four hooks of the plugin. A plugin update that changes a script asks for a new review.

## Configure the gates

The gates of a repo live in `.gates.json` at its root, committed. The quickest start is `catalog/`: one file per technology, each gate with what it catches and the tools it requires, and `catalog/index.html` is the same content as a page. Copy a gate into `.gates.json`, install what it requires, and adapt its `files` to the layout of the repo.

A gate names a command, and the files that make it run:

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

- `name`: lowercase words joined by hyphens.
- `severity`: `error` sends the agent back when the gate fails, `off` turns the gate off.
- `files`: a regular expression on the repo-relative paths. The gate runs when the turn changed a match.
- `run`: the command, then its arguments. `{files}` expands to the changed files the gate looks at.

A gate whose tool is not installed does not run: as the next prompt arrives, the agent is asked to install it.

[docs/configuration.md](docs/configuration.md) gives the rest: every field of a gate, how `run` finds its program, the settings of the whole check, and the overrides each developer keeps in `.gates.local.json`.

## How a turn is checked

1. When a prompt arrives, the engine records the working tree as a commit that no branch points to, without touching the index, the files or any branch.
2. When the agent stops, it records the tree again and lists the files the turn changed.
3. Each gate with a matching file runs, all of them in parallel, with the gates as the turn started.
4. If a gate fails, the agent is sent back with the reports, told to fix the code and never the check. Each stop is checked again from the turn start, so a fix that breaks another gate is caught, up to 5 times a turn by default ([`maxSendBacks`](docs/configuration.md#the-settings-of-the-whole-check)).
5. The agent may instead waive a red gate, with a reason you see in orange in the summary: for the turn only, and never in CI. [docs/turn.md](docs/turn.md#the-waivers) says when and how.

Each stop ends with a summary, such as:

```
● gates  2/3 gates green in 5.1 s · the agent is sent back to fix it (1 of 5)
✗ tests 5.0 s
✓ clones 900 ms  ✓ lint 300 ms
```

[docs/turn.md](docs/turn.md) draws the rest: where the start comes from, how a compared gate reads its report, what the engine keeps between turns, and what the lock covers.

To check the whole repo, as before adopting the gates, in a pre-push hook or in CI:

```
npx @tayomi/deterministic-gates check
```

Every gate runs on every file that matches, and the command exits with 1 when a gate fails. With `--format json`, it prints each gate and its status for a tool to read: see [the whole check](docs/turn.md#the-whole-check).

## Develop

```
pnpm install --frozen-lockfile
pnpm check
pnpm integration
```

This repo runs under its own gates, in its `.gates.json`, and no gate runs a whole test suite at the end of a turn: that is what `pnpm check`, `pnpm integration` and `node src/cli.ts check` are for.

`integration/` holds a sample project per catalog. The integration tests play an agent's turn on each, with no agent and no model: a clean change passes every gate, and each gate catches the fault written for it. A gate whose tool is not installed fails its test, with how to install it: every tool the catalogs require is needed. To add a gate to a catalog, edit its file, write its fault, and run `pnpm catalog` to regenerate the page.

CI runs `pnpm check` and `pnpm integration` on every push and pull request, with the tool of every catalog gate installed. A tool a new gate requires is added to `.github/workflows/ci.yml`.

## License

MIT
