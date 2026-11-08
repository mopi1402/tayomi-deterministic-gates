# Changelog

## 0.2.0

### Added

- `maxTimeoutSeconds`, at the top of `.gates.json` or `.gates.local.json`: one time budget for the whole check, 45 seconds by default
- A gate out of time is drawn orange ⏱, neither green nor red, and never sends the agent back
- At each prompt, a gate whose tool this machine lacks is found without running it: the agent is asked once per session to install it, and the owner is told which gates are off
- A new session, a resume or a clear asks again for the missing tools, a compaction does not: the plugin adds a `SessionStart` hook

### Changed

- A gate's `timeoutSeconds` defaults to the budget, 45 seconds instead of 30, and one longer than the budget is cut to it instead of refused
- A gate whose tool is missing no longer fails: it is skipped, never sends the agent back, and is named when the turn touched its files
- A gate whose entry is wrong (an unknown field, a bad pattern, a bad severity) is left out alone and named, where it used to stop every gate
- The catalog's gates no longer set their own `timeoutSeconds`

### Fixed

- A hook that writes or deletes files while the check records the turn, as another plugin's Stop hook may, no longer stops the check
- A test gate reports a failure once, whatever the number of test files it hit

## 0.1.0

### Added

- First release, a plugin for Claude Code and Codex: at the end of each turn, the gates of `.gates.json` run in parallel on the files the agent changed, each one a tool and never a model
- A failing gate sends the agent back once with its report, told to fix the code and never the check, then only the owner is told
- A turn is checked with the gates as it started, so an agent that edits `.gates.json` mid-turn changes the next turn, never its own
- `compare: turn-start` runs a gate on the whole project as the turn starts, and only the lines of output the turn added fail it
- A gate runs a script of the engine, a script of the repo, a package of `node_modules` or any program, with `{files}` and `{turn}` in its arguments
- `.gates.local.json` lets each developer override or add gates without touching the shared file
- A turn the owner interrupts is checked with the next turn of its repo
- `node src/cli.ts check` runs every gate on the whole repo and exits with 1 when one fails
- `catalog/` lists gates worth copying, per technology, each with what it catches and the tools it requires
