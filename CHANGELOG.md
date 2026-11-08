# Changelog

## 0.2.0

- A check has one time budget, `maxTimeoutSeconds` at the top of `.gates.json` or `.gates.local.json`, 45 seconds by default
- A gate's own `timeoutSeconds` can only be shorter than that budget: a longer one is cut to it, never refused
- A gate out of time is drawn orange ⏱, neither green nor red, and never sends the agent back
- At each prompt, a gate whose tool this machine lacks is found without running it: the agent is asked once per session to install it, and the owner is told which gates are off
- A gate whose tool is missing is skipped at the end of the turn, never sends the agent back, and is named when the turn touched its files
- A new session, a resume or a clear asks again for the missing tools, a compaction does not: the plugin adds a `SessionStart` hook
- A gate whose entry is wrong (an unknown field, a bad pattern, a bad severity) is left out alone and named, and the other gates still run
- The turn's tree is recorded from the files git lists, so a file another hook deletes meanwhile no longer stops the check
- A test gate reports a failure once, whatever the number of test files it hit
- The catalog's gates no longer set their own `timeoutSeconds`

## 0.1.0

- First release
