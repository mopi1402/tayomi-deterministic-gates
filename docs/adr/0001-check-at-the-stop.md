# Check at the stop, while the context is fresh

The gates run when the agent stops, on what its turn changed, and a failure sends it back at once. The agent still holds the context of the code it just wrote, so the fix is cheap and right; a review or a CI run finds the same problem once that context is gone, and the fix then costs a new session, a reread, or a human.

## Considered options

- **After each edit**: the code is often mid-change, half a refactor fails a gate that the end of the turn would pass, and every edit pays for the gates.
- **At the commit**: an agent may not commit, and when it does, the turn that wrote the code may be over.
- **In CI only**: the context is gone, and the loop goes through a human.
