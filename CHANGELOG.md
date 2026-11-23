# Changelog

## 0.5.0

### Added

- `watch` on a gate: a long-running command, such as a test or build watch, that the engine keeps warm between turns, one per repo and gate, shared by the sessions of the repo. At the stop, it waits for a cycle that started after the last change of the turn, so one that read it however long the watch took to see it, and judges the turn on that cycle once it closes. The watch stops when the last session using it ends, or after 30 minutes without a prompt nor a stop. `check`, so CI, runs the gate's own `run` once
- A gate that keeps a watch and has `compare` fails only on the lines its last cycle added to the cycle the turn started on
- A `SessionEnd` hook, which stops the watches a session was the last to use
- An Angular catalog: `tests` runs `ng test` with Vitest in a watch and reports every red spec, the ones a change did not rerun included; `build` runs `ng build` in a watch, which type-checks every template, those of a component no spec reaches included; `template-lint` runs angular-eslint on the changed templates
- `no-new-strict-errors` in the TypeScript catalog: tsc with `strictNullChecks` and `strictPropertyInitialization` on, in a watch, failing only on the errors the turn added, so a project that turned them off stops growing new ones

## 0.4.2

### Fixed

- The usage line of the CLI names the `deterministic-gates` bin, where it named `node src/cli.ts`, a path that exists only in this repo

## 0.4.1

### Fixed

- The npm package ships its `deterministic-gates` bin: npm dropped the bin of 0.4.0 at publish, judging its `./`-prefixed path invalid, so 0.4.0 never reached npm

## 0.4.0

### Added

- An npm package, `@tayomi/deterministic-gates`, whose bin checks the whole repo: `npx @tayomi/deterministic-gates check`, as before adopting the gates, in a pre-push hook or in CI. It runs the engine built to JavaScript, since Node strips no type under node_modules
- Claude Code no longer shows the waive lines of a reply, which it printed raw: a mod draws each reply without them, a resumed session included, and a `MessageDisplay` hook hides them where mods do not run. Codex already hid them

## 0.3.0

### Added

- `--require-tests` on the `related-node-tests` helper fails on each changed file no test reaches, where the related tests alone pass in silence
- `showAllPasses`, at the top of `.gates.json` or `.gates.local.json`: the summary names every green gate, six to a line, instead of counting those past the sixth
- `maxSendBacks`, at the top of `.gates.json` or `.gates.local.json`: the most times a turn sends the agent back, 5 by default, 0 never
- A waive line, `[deterministic-gates:<gate>]: waive "<reason>"` in the agent's last message, leaves a red gate for the turn when it cannot be fixed, goes against what the owner asked, or needs the owner first: the summary draws it orange ⚠ with the reason under it, and it falls when the gate's report changes

### Changed

- A red gate sends the agent back at every stop of the turn until it is fixed or waived, up to `maxSendBacks`, where it used to send it back once: a fix that breaks another gate no longer ships

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
