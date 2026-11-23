import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { type Gate, isCompared, type Watch, type WatchedGate } from "./config.ts";
import { addedLines, cleaned, commandOf, ENGINE_VERSION, type Outcome, TOOL_ENV } from "./run.ts";

// Once a cycle closes, the lines a watch prints after it, such as the errors of a failed build, come within this long.
const QUIET_MS = 1000;
// A change no cycle started after in this long is one the watch does not look at, such as a spec its build leaves out:
// it cannot change the last cycle, which then judges the turn.
const UNSEEN_MS = 5000;
const POLL_MS = 100;
// What a watch that stopped leaves the agent: enough to see the error, not the whole history of the session.
const LAST_LINES = 20;
// A prompt waits this long at most for a compared watch to settle, under the 60 s its hook has.
const TURN_START_MS = 45_000;

const PREFIX = "gates-watch-";
// A start that holds its lock longer than this died on the way: the next hook takes the lock over.
const STALE_START_MS = 10_000;
// A watch stops by itself after this long without a prompt nor a stop on its repo, as for a session left open. The
// tests of the engine shorten it.
const IDLE_MS = 30 * 60 * 1000;

function idleMs(): number {
  return Number(process.env.GATES_WATCH_IDLE_MS) || IDLE_MS;
}

/** Records a prompt or a stop on the repo of a watch, which keeps it from stopping for idleness. */
function touch(folder: string): void {
  writeFileSync(join(folder, "activity"), "");
}

/** Records a stop on the repo of the watch of a gate, if it has one, whether the stop judges it or not. */
export function keepWatch(root: string, gate: Gate): void {
  const folder = folderOf(root, gate);
  if (existsSync(folder)) touch(folder);
}

/**
 * Where a watch keeps its process, its output and the sessions that use it, outside the repo: one per repo, gate and
 * engine version, since a helper of the engine may print its cycles otherwise from one version to the next.
 */
function folderOf(root: string, gate: Gate): string {
  const key = createHash("sha256").update(`${root}\0${gate.name}\0${ENGINE_VERSION}`).digest("hex").slice(0, 16);
  return join(tmpdir(), `${PREFIX}${key}`);
}

// A file per session that uses the watch: two hooks at once each write their own, and neither loses the other's.
function sessionFile(folder: string, session: string): string {
  return join(folder, "sessions", session.replace(/[^\w-]/g, ""));
}

function register(folder: string, session: string): void {
  mkdirSync(join(folder, "sessions"), { recursive: true });
  writeFileSync(sessionFile(folder, session), "");
}

/** Whether the watch runs, has stopped on its own, was stopped for idleness, or was never started. */
function stateOf(folder: string): "running" | "stopped" | "idle" | "absent" {
  let pid: number;
  try {
    pid = Number(readFileSync(join(folder, "pid"), "utf8"));
  } catch {
    return "absent";
  }
  try {
    if (!pid) return "stopped";
    process.kill(pid, 0);
    return "running";
  } catch {
    return existsSync(join(folder, "idle")) ? "idle" : "stopped";
  }
}

/**
 * Starts the watch of a gate in the background, unless it already runs, and records that the session uses it: it
 * outlives the hook that starts it, until no session uses it.
 */
export function startWatch(session: string, root: string, gate: WatchedGate): void {
  const folder = folderOf(root, gate);
  mkdirSync(folder, { recursive: true });
  touch(folder);
  // The sessions of a watch that starts again still use it.
  register(folder, session);
  if (stateOf(folder) === "running") return;
  // Two hooks at once, such as two sessions starting, start one watch: the other only registers its session.
  const lock = join(folder, "starting");
  if (Date.now() - changedAt(lock) >= STALE_START_MS) rmSync(lock, { force: true });
  try {
    closeSync(openSync(lock, "wx"));
  } catch {
    return;
  }
  try {
    // Another hook may have started it between the look above and the lock.
    if (stateOf(folder) !== "running") launch(folder, root, gate.watch);
  } finally {
    rmSync(lock, { force: true });
  }
}

function launch(folder: string, root: string, watch: Watch): void {
  rmSync(join(folder, "idle"), { force: true });
  const [name = "", ...args] = watch.run;
  const command = commandOf(root, name);
  const supervisor = commandOf(root, "{engine}/src/core/watch.ts");
  const watched = [
    join(folder, "activity"),
    String(idleMs()),
    watch.cycleStart,
    command.file,
    ...command.args,
    ...args,
  ];
  const log = openSync(join(folder, "output.log"), "w");
  const child = spawn(supervisor.file, [...supervisor.args, ...watched], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: TOOL_ENV,
  });
  closeSync(log);
  child.on("error", () => {});
  child.unref();
  writeFileSync(join(folder, "pid"), String(child.pid ?? ""));
}

/** The last cycle of a watch: its lines since it opened, and whether it is still open. */
function lastCycle(printed: string, watch: Watch): { open: boolean; lines: string[] } {
  const lines = printed.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const opens = new RegExp(watch.cycleStart);
  const closes = new RegExp(watch.cycleEnd);
  // The start of the watch opens the first cycle, and lines after the one that closes it still belong to it.
  const cycle = lines.slice(lines.findLastIndex((line) => opens.test(line)) + 1);
  return { open: !cycle.some((line) => closes.test(line)), lines: cycle };
}

function changedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readLog(log: string): string {
  try {
    return readFileSync(log, "utf8");
  } catch {
    return "";
  }
}

/** Where a watch is once it has settled, with the lines of its last cycle, or once it can no longer settle. */
type Settled = { ms: number } & ({ cycle: string } | { stopped: string } | { timedOut: true });

/**
 * Waits for the watch of a gate to settle: no cycle open, and for a quiet while neither new output nor a new change to
 * one of the files. A watch no hook started, as when the hooks were installed mid-session, starts now, and so does one
 * stopped for idleness, as during a turn longer than the idle delay: it is not to blame.
 */
async function settle(
  session: string,
  root: string,
  gate: WatchedGate,
  files: string[],
  limitMs: number,
): Promise<Settled> {
  const started = performance.now();
  const folder = folderOf(root, gate);
  const log = join(folder, "output.log");
  if (["absent", "idle"].includes(stateOf(folder))) startWatch(session, root, gate);
  touch(folder);
  for (;;) {
    // Read once the watch is known stopped, so its last lines are in.
    const stopped = stateOf(folder) === "stopped";
    const printed = readLog(log);
    const ms = performance.now() - started;
    if (stopped) {
      const last = cleaned(
        root,
        printed
          .split("\n")
          .slice(-LAST_LINES - 1)
          .join("\n"),
      );
      return {
        ms,
        stopped: last ? `The watch stopped. Its last lines:\n${last}` : "The watch stopped, with no output.",
      };
    }
    // A cycle that started after the last change read it, however long the watch took to see it.
    const changed = Math.max(0, ...files.map((file) => changedAt(join(root, file))));
    const seen = changedAt(join(folder, "cycle")) >= changed || Date.now() - changed >= UNSEEN_MS;
    const cycle = lastCycle(printed, gate.watch);
    if (seen && !cycle.open && Date.now() - changedAt(log) >= QUIET_MS)
      return { ms, cycle: cleaned(root, cycle.lines.join("\n")) };
    if (ms >= limitMs) return { ms, timedOut: true };
    await sleep(POLL_MS);
  }
}

/**
 * Judges a turn on the last cycle of the watch of a gate, once the watch has settled with the files of the turn the
 * gate looks at: on its failed lines, or for a compared gate, on the lines it added to the report of the turn start.
 * Not settled in the time of the gate: out of time, neither green nor red. A watch that stopped fails, with the last
 * lines it printed.
 */
export async function judgeWatch(
  session: string,
  root: string,
  gate: WatchedGate,
  files: string[],
  baseline: string | undefined,
): Promise<Outcome> {
  const settled = await settle(session, root, gate, files, gate.timeoutSeconds * 1000);
  const { name } = gate;
  const { ms } = settled;
  if ("stopped" in settled) return { name, ok: false, ms, output: settled.stopped, report: undefined };
  if ("timedOut" in settled) {
    const output = `The watch did not settle within ${gate.timeoutSeconds} s, so not judged. Make it faster, or move it to CI.`;
    return { name, ok: false, ms, output, report: undefined, timedOut: true };
  }
  const { cycle } = settled;
  const fails = new RegExp(gate.watch.failed ?? "(?!)");
  const judged = isCompared(gate)
    ? addedLines(gate, cycle, baseline)
    : { ok: !cycle.split("\n").some((line) => fails.test(line)), output: cycle };
  return { name, ms, ...judged, report: judged.ok ? cycle : undefined };
}

/**
 * The report a compared watch gives the turn start: its last cycle, once it settles in the time a prompt can wait.
 * Nothing when it does not, and the turn then counts nothing as new.
 */
export async function watchReport(session: string, root: string, gate: WatchedGate): Promise<string | undefined> {
  const settled = await settle(session, root, gate, [], Math.min(gate.timeoutSeconds * 1000, TURN_START_MS));
  return "cycle" in settled ? settled.cycle : undefined;
}

/** Stops each watch the session was the last to use, in any repo: the watch and every process it started. */
export function endSession(session: string): void {
  for (const entry of readdirSync(tmpdir())) {
    if (!entry.startsWith(PREFIX)) continue;
    const folder = join(tmpdir(), entry);
    const file = sessionFile(folder, session);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    if (!readdirSync(join(folder, "sessions")).length) stop(folder);
  }
}

function stop(folder: string): void {
  if (stateOf(folder) !== "running") return;
  try {
    process.kill(-Number(readFileSync(join(folder, "pid"), "utf8")), "SIGTERM");
  } catch {}
}

/**
 * The supervisor of a watch, which this module runs as when the engine starts one: it runs the watch, its output
 * going where its own goes, and stops it with every process it started once its repo has had no prompt nor stop for
 * the idle delay. Started detached, it leads a process group of its own, so stopping the group stops the watch and
 * the tools under it.
 */
function supervise(activity: string, idle: number, cycleStart: string, file: string, args: string[]): void {
  // The time the last cycle started, which the stop compares with the changes of the turn. The start opens the first.
  const cycle = join(dirname(activity), "cycle");
  const opens = new RegExp(cycleStart);
  writeFileSync(cycle, "");
  const watch = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  const forward = (line: string) => {
    // Printed before the time is kept, so a stop that sees the time also finds the cycle in the output.
    console.log(line);
    if (opens.test(line)) writeFileSync(cycle, "");
  };
  createInterface({ input: watch.stdout }).on("line", forward);
  createInterface({ input: watch.stderr }).on("line", forward);
  watch.on("error", (error) => {
    console.log(error.message);
    process.exit(1);
  });
  watch.on("close", (code) => process.exit(code ?? 1));
  setInterval(
    () => {
      if (Date.now() - changedAt(activity) < idle) return;
      writeFileSync(join(dirname(activity), "idle"), "");
      process.kill(-process.pid, "SIGTERM");
    },
    Math.min(idle / 4, 10_000),
  );
}

if (import.meta.main) {
  const [activity = "", idle = "", cycleStart = "", file = "", ...args] = process.argv.slice(2);
  supervise(activity, Number(idle), cycleStart, file, args);
}
