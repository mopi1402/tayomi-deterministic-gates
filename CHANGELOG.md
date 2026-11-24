# Changelog

## 0.9.0

### Fixed

- After an update of the engine, a session leaves the watch the version before started for a gate, which stops once no session uses it, where it ran beside the new one until the session ended
- `no-new-suppressions` reports a suppression that says the same as one already in the file
- `no-new-suppressions` no longer reports an old suppression at the end of a line the turn changed
- A gate that broke, by its command or its watch, tells the agent to repair what stops it from running

### Added

- `no-new-bulk-suppressions` in the TypeScript catalog fails when the turn raised a count of an ESLint suppressions file
- `prompts` in a gates file and `prompt` on a gate add a text of the repo to what the agent is told, or replace it
- `maxReportChars`, for the whole check or for a gate, sets how much of a report the agent is sent
- `omitLines` on a gate leaves lines of its report out of what the agent is sent
- `check --format json` prints the check for a tool to read, each gate with its status

### Changed

- `no-new-suppressions` knows `stylelint-disable`, and the gate of the TypeScript catalog reads `.css` and `.scss` files
- `no-new-clones` tells the agent to reuse the code already there, or to factor it out
- A long report is cut between two lines when they are short enough, and says how many lines it cut
- The agent is told how to act on a send-back once a session in a repo, and in one line after, until the session starts again or compacts
- A send-back holds 4000 characters of reports at most, all gates together: `maxTotalReportChars` sets it

## 0.8.2

### Changed

- `no-new-strict-errors` of the Angular catalog says what its check before said when no file it read has changed, without checking again

## 0.8.1

### Fixed

- A cycle a watch opens for a change of another gate or session no longer answers for a touch the watch missed, which passed a broken change green: a stop waits for four cycles of a watch again, as in 0.7.0

## 0.8.0

### Changed

- `no-new-strict-template-errors` of the Angular catalog becomes `no-new-strict-errors`, and its helper `angular-errors.ts`: it reports the strict errors of the TypeScript too, from the same program. A copy of the gate needs the new entry

### Added

- The gate keeps the Angular compiler between turns, and reuses what it compiled
- Its `run` lists the options of TypeScript to force, and refuses one TypeScript does not know

## 0.7.1

### Fixed

- A watch that opens no cycle for its `watch.sync` fails after five touches and says so, where the gate waited until it was out of time
- The `build` gate of the Angular catalog asks through `src/main.ts`: Angular 21 does not rebuild for a tsconfig. For `tests` on Angular 21, give `watch.sync` a spec
- A stop waits for three cycles of a watch, where it waited for four
- A stop no longer reads the whole output of a watch again at each look

## 0.7.0

### Changed

- `watch.sync` is required on a gate that keeps a watch: a file whose date change makes the watch open a cycle, such as its tsconfig. A copy of a watch gate in a `.gates.json` needs it

### Added

- `no-new-strict-template-errors` in the Angular catalog: fails on the strict template errors the turn added
- `watch.frozen`: the files a watch lists only as it starts, such as the specs of `ng test`. The watch starts again when they change

### Fixed

- A watch is judged only on a cycle it opened after the engine asked for one, where a change it had not read yet could pass green
- A change made during the first build of a watch is judged
- A spec created or deleted in a turn is judged
- The files of a stop that ran out of time are judged at the next stop

## 0.6.1

### Fixed

- A package of the repo, such as `ng` or `tsc`, and a script of the repo run on the Node the repo pins as a package in `node_modules/.bin`, as npx runs them, where they ran on the Node of the engine: an Angular project tested on another Node than its own had specs red that pass with `ng test`. Every tool runs with `node_modules/.bin` first on its `PATH`, so the programs it starts find the same
- `no-new-strict-errors` reports a new error that says what an old one the turn fixed in another file said, which it took for that one reported elsewhere. A `lineKey` may name a group `file`: a line of a file the turn changed is never one reported elsewhere. The catalog's key is now `"^((?<file>.+?): error TS\\d+) at [^\\t]*"`, and a copy of the gate with the key of 0.6.0 works as it did
- The `tests` gate of the Angular catalog reports the state of the specs and the errors of a build that failed, without the table of the files the build wrote: in a large project it hid the failed specs, and since its file names change at each build, a waiver of the gate fell at every stop. The line that ends a run no longer gives Angular's reason, which said all tests passed of a run with failed specs. A watch that stops prints the last 20 lines of `ng test`
- A new prompt restarts the send-backs of the turn, which went on from the turn before when the prompt's hook did not finish, as when it ran out of its 60 s: the turn is recorded before the reports of its start run, and those reports have 45 s, together, where a compared gate without a watch had the whole time of the check

## 0.6.0

### Changed

- `no-new-strict-errors` prints each error as a key, its file, code and source line, then its message after a tab, and the catalog gives it a `lineKey` to compare by. A copy of the gate in a `.gates.json` needs that `lineKey` too, `"^(.+?: error TS\\d+) at [^\\t]*"`: without it, the whole line is compared, message included, and the errors a project already had come back as new

### Added

- `lineKey` on a compared gate: a regular expression for the part of a line that tells it apart, when the rest prints otherwise from run to run. A line of a new key is still an old one, each line of the turn start whose key went standing for one line only: when it says the same as such a line, a problem reported elsewhere; then, when the first group of the key is the one of such a line, a problem that changed where it is

### Fixed

- `no-new-strict-errors` no longer reports the errors a project already had as new. A watch of tsc checks again only the files a change reaches, with types created in another order: the members of a union, the properties of an object, and the file of an error tsc reports once per type all change. An error is now told by its file, code and source line, its message following after a tab for the agent, cut at 300 characters. An error on a line the turn changed stays old as long as its file has no more errors of its code than at the turn start. The sort of 0.5.1, which mixed the unions of different properties, is gone

## 0.5.1

### Fixed

- `no-new-strict-errors` no longer reports the errors a project already had as new after the first compilation of its watch: tsc orders the members of a union otherwise between that compilation and the next ones, so each union prints sorted and untruncated, and an error keeps only its first line, since the lines under it name its first failing member
- A report kept from a tree, and a running watch, serve only the engine version that made them: a helper may print otherwise from one version to the next, and a report of the old format would have made every line of it new
- `typecheck` writes no JavaScript: tsc ran with the emit of the project's tsconfig, into its outDir or next to its sources
- `typecheck` and `no-new-strict-errors` refuse a tsconfig.json that only references others, as the one of an Angular project, where tsc checks no file and the gate was green without checking anything
- A compared watch with no report from the turn start says it judged nothing, where it said it counted an exit code a watch does not have

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
