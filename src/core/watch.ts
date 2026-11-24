import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as sleep } from "node:timers/promises";
import { type Gate, isCompared, type Watch, type WatchedGate } from "./config.ts";
import { addedLines, cleaned, commandOf, ENGINE_VERSION, type Outcome, toolEnv } from "./run.ts";
import { listFiles } from "./snapshot.ts";

// A watch that has not opened a cycle this long after the engine touched its sync file is touched again: it may look
// for changes only once its first cycle is over, as Angular and tsc do, and never see a touch made before. Each wait
// is twice the one before, since a watch on a busy machine takes seconds to say it opens a cycle, and a touch too
// many is a cycle too many. The wait changes no verdict, which only ever comes from a cycle the watch opened after a
// touch. The tests of the engine shorten it.
const RESYNC_MS = 1000;
// A watch that opens no cycle after this many touches, 31 s after the first, does not look at its sync file.
const SYNC_TOUCHES = 5;
const POLL_MS = 100;
// What a watch that stopped leaves the agent: enough to see the error, not the whole history of the session.
const LAST_LINES = 20;
// A prompt waits this long at most for the reports of its compared gates, under the 60 s its hook has.
export const TURN_START_MS = 45_000;

const PREFIX = "gates-watch-";
// A start that holds its lock longer than this died on the way: the next hook takes the lock over.
const STALE_START_MS = 10_000;
// A watch stops by itself after this long without a prompt nor a stop on its repo, as for a session left open. The
// tests of the engine shorten it.
const IDLE_MS = 30 * 60 * 1000;

function idleMs(): number {
  return Number(process.env.GATES_WATCH_IDLE_MS) || IDLE_MS;
}

function resyncMs(): number {
  return Number(process.env.GATES_WATCH_RESYNC_MS) || RESYNC_MS;
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

/** The process of the watch, as the engine recorded it when it started it, or nothing when it never did. */
function processOf(folder: string): string | undefined {
  try {
    return readFileSync(join(folder, "pid"), "utf8");
  } catch {
    return undefined;
  }
}

/** Whether the watch runs, has stopped on its own, was stopped by the engine, or was never started. */
function stateOf(folder: string): "running" | "stopped" | "idle" | "absent" {
  const recorded = processOf(folder);
  if (recorded === undefined) return "absent";
  try {
    if (!Number(recorded)) return "stopped";
    process.kill(Number(recorded), 0);
    return "running";
  } catch {
    return existsSync(join(folder, "idle")) ? "idle" : "stopped";
  }
}

// Two hooks at once, such as two sessions starting, start one watch: only the one that holds the lock does.
function lockStart(folder: string): boolean {
  const lock = join(folder, "starting");
  // Only a lock that is there and old is taken over: removing one on the word of a look that found none would remove
  // the lock another hook has just taken, and both would start a watch.
  const taken = changedAt(lock);
  if (taken && Date.now() - taken >= STALE_START_MS) rmSync(lock, { force: true });
  try {
    closeSync(openSync(lock, "wx"));
    return true;
  } catch {
    return false;
  }
}

function unlockStart(folder: string): void {
  rmSync(join(folder, "starting"), { force: true });
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
  if (stateOf(folder) === "running" || !lockStart(folder)) return;
  try {
    // Another hook may have started it between the look above and the lock.
    if (stateOf(folder) !== "running") launch(folder, root, gate.watch);
  } finally {
    unlockStart(folder);
  }
}

/** The files of the repo the watch lists only as it starts, one per line. */
function frozenFiles(root: string, watch: Watch): string {
  if (watch.frozen === undefined) return "";
  const frozen = new RegExp(watch.frozen);
  return listFiles(root)
    .filter((file) => frozen.test(file))
    .join("\n");
}

function launch(folder: string, root: string, watch: Watch): void {
  rmSync(join(folder, "idle"), { force: true });
  // The first cycle of a watch reads every file there is: it owes a cycle for none.
  rmSync(join(folder, "owed"), { recursive: true, force: true });
  // What the watch before this one left of its cycles.
  for (const left of ["cycles", "cycle", "last"]) rmSync(join(folder, left), { force: true });
  const [name = "", ...args] = watch.run;
  const command = commandOf(root, name);
  const supervisor = commandOf(root, "{engine}/src/core/watch.ts");
  const cycle = [watch.cycleStart, watch.cycleEnd];
  const watched = [folder, String(idleMs()), ...cycle, command.file, ...command.args, ...args];
  // Listed before the watch starts: a file created in between counts as one it may not know, never the other way.
  writeFileSync(join(folder, "frozen"), frozenFiles(root, watch));
  const log = openSync(join(folder, "output.log"), "w");
  const child = spawn(supervisor.file, [...supervisor.args, ...watched], {
    cwd: root,
    detached: true,
    stdio: ["ignore", log, log],
    env: toolEnv(root),
  });
  closeSync(log);
  child.on("error", () => {});
  child.unref();
  writeFileSync(join(folder, "pid"), String(child.pid ?? ""));
}

/** The cycles of a watch since it started, as its supervisor counts them. */
interface Cycles {
  /** How many cycles the watch opened, the one its start opens left out. */
  opened: number;
  /** Whether the last cycle is still open. */
  open: boolean;
}

// A watch whose supervisor has written nothing yet is in the cycle its start opens.
function cyclesOf(folder: string): Cycles {
  const [opened, state] = readText(join(folder, "cycles")).split(" ");
  return { opened: Number(opened), open: state !== "closed" };
}

/** Gives the files their date again, as a change of nothing else, for a watch that looks at their date. */
function touchAgain(paths: string[]): void {
  const now = new Date();
  for (const path of paths) {
    try {
      utimesSync(path, now, now);
    } catch {}
  }
}

function changedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Writes a file at once, so that a hook reading it never finds half of it. */
function writeWhole(path: string, text: string): void {
  writeFileSync(`${path}.new`, text);
  renameSync(`${path}.new`, path);
}

/** Where a watch is once it has answered, with the lines of the cycle that judges, or once it no longer can. */
type Settled = { ms: number } & ({ cycle: string } | { stopped: string } | { timedOut: true });

/**
 * Starts the watch again when a file it lists only as it starts was created or deleted since: its first cycle then
 * reads every file there is. Only one hook does, and only the watch it looked at: another session may be here too.
 */
async function restartOnFrozenChange(session: string, root: string, gate: WatchedGate, folder: string): Promise<void> {
  if (gate.watch.frozen === undefined || stateOf(folder) !== "running") return;
  if (readText(join(folder, "frozen")) === frozenFiles(root, gate.watch) || !lockStart(folder)) return;
  try {
    if (stateOf(folder) !== "running" || readText(join(folder, "frozen")) === frozenFiles(root, gate.watch)) return;
    // Stopped by the engine, so that another session waiting on the watch does not take it for one that broke.
    writeFileSync(join(folder, "idle"), "");
    stop(folder);
    for (let waited = 0; stateOf(folder) === "running" && waited < STALE_START_MS / 2; waited += POLL_MS)
      await sleep(POLL_MS);
    if (stateOf(folder) !== "running") launch(folder, root, gate.watch);
  } finally {
    unlockStart(folder);
  }
  register(folder, session);
}

/**
 * Asks the watch of a gate for a cycle that read the files of the turn, and waits for it, with no guess on how long a
 * watch takes to see a change. Each round touches files, then waits for the watch to open a cycle after the touch,
 * which only a watch that saw the touch does:
 * 1. the sync file alone. The cycle that follows proves the watch now looks for changes, whoever made it open: a
 *    watch may look for them only once its first cycle is over, as Angular and tsc do, and a touch made before is
 *    lost. Touched with the sync file in this round, the files of the turn could be lost with it, and a cycle the
 *    watch then opens for a change of someone else, another gate or another session, would answer for them;
 * 2. the files of the turn, so that a change it missed reaches it, then the sync file;
 * 3. the sync file, once that cycle has closed: the cycle of round 2 may have been on its way before the touch, and
 *    this one opens after every change the watch then had waiting;
 * 4. the sync file once more, since the cycle it opens ends the one of round 3, the one that judges, whose last lines
 *    may come after the line that closes it.
 * A watch that opens no cycle however often it is touched does not look at its sync file, and is said so. A watch no
 * hook started, as when the hooks were installed mid-session, starts now, and so does one the engine
 * stopped, for idleness or to start it again: it is not to blame. One another session starts again meanwhile is asked
 * again from the first round.
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
  const sync = join(root, gate.watch.sync);
  if (!existsSync(sync)) {
    const stopped = `The watch cannot be asked for a cycle: its watch.sync, ${gate.watch.sync}, does not exist.`;
    return { ms: 0, stopped };
  }
  await restartOnFrozenChange(session, root, gate, folder);
  const turn = files.map((file) => join(root, file)).filter((path) => existsSync(path));
  const rounds = [[sync], ...(turn.length ? [[...turn, sync]] : []), [sync], [sync]];
  let asked: string | undefined;
  let round = 0;
  // The cycles the watch had opened when the round touched its files, when it last did, and how many times: none
  // before its first touch.
  let touched: { opened: number; at: number; times: number } | undefined;
  for (;;) {
    const state = stateOf(folder);
    if (state === "absent" || state === "idle") startWatch(session, root, gate);
    // Waiting on the watch is using it: it does not stop for idleness under a stop that waits.
    touch(folder);
    const ms = performance.now() - started;
    if (state === "stopped") {
      // Read once the watch is known stopped, so its last lines are in: the ones its supervisor kept, or what the
      // supervisor itself printed when it broke.
      const printed = readText(join(folder, "last")) || readText(join(folder, "output.log"));
      const last = cleaned(root, printed.trimEnd().split("\n").slice(-LAST_LINES).join("\n"));
      return {
        ms,
        stopped: last ? `The watch stopped. Its last lines:\n${last}` : "The watch stopped, with no output.",
      };
    }
    const running = processOf(folder);
    if (running !== asked) {
      asked = running;
      round = 0;
      touched = undefined;
    }
    const cycles = cyclesOf(folder);
    if (state === "running" && touched === undefined) {
      // A round starts once the cycle before it has closed.
      if (!cycles.open) {
        touchAgain(rounds[round] ?? []);
        touched = { opened: cycles.opened, at: Date.now(), times: 1 };
      }
    } else if (touched !== undefined && cycles.opened > touched.opened) {
      // Written before the count of the cycle that ended it: the cycle read is that one, or a later one.
      if (round === rounds.length - 1) return { ms, cycle: cleaned(root, readText(join(folder, "cycle"))) };
      round++;
      touched = undefined;
      continue;
    } else if (touched !== undefined && Date.now() - touched.at >= resyncMs() * 2 ** (touched.times - 1)) {
      if (touched.times === SYNC_TOUCHES) {
        const stopped = `The watch opens no cycle when the date of its watch.sync, ${gate.watch.sync}, changes: give it a file the watch rebuilds for, such as a source file it reads.`;
        return { ms, stopped };
      }
      touchAgain(rounds[round] ?? []);
      touched = { ...touched, at: Date.now(), times: touched.times + 1 };
    }
    if (ms >= limitMs) return { ms, timedOut: true };
    await sleep(POLL_MS);
  }
}

/**
 * The files the watch owes a cycle for: the ones of the stops it was out of time for, which no cycle is known to have
 * read. Each such stop writes a list of its own, so two sessions never lose the files of each other.
 */
function owedFiles(folder: string): { lists: string[]; files: string[] } {
  const lists = readDir(join(folder, "owed")).map((name) => join(folder, "owed", name));
  const files = lists.flatMap((list) => readText(list).split("\0").filter(Boolean));
  return { lists, files: [...new Set(files)] };
}

function owe(folder: string, files: string[]): void {
  mkdirSync(join(folder, "owed"), { recursive: true });
  writeFileSync(join(folder, "owed", randomUUID()), files.join("\0"));
}

function readDir(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/**
 * Judges a turn on a cycle of the watch of a gate that read the files of the turn the gate looks at: on its failed
 * lines, or for a compared gate, on the lines it added to the report of the turn start. No such cycle in the time of
 * the gate: out of time, neither green nor red, never judged on an older cycle. The watch then owes a cycle for these
 * files, which the next stop it answers asks for with its own: a change it missed would otherwise stay unseen until
 * the file changes again. Only a stop pays that debt, never the report of a turn start, which would make old a
 * failure no turn was judged on. A watch that stopped fails, with the last lines it printed.
 */
export async function judgeWatch(
  session: string,
  root: string,
  gate: WatchedGate,
  files: string[],
  baseline: string | undefined,
): Promise<Outcome> {
  const folder = folderOf(root, gate);
  const owed = owedFiles(folder);
  const asked = [...new Set([...files, ...owed.files])];
  const settled = await settle(session, root, gate, asked, gate.timeoutSeconds * 1000);
  const { name } = gate;
  const { ms } = settled;
  if ("stopped" in settled) return { name, ok: false, ms, output: settled.stopped, report: undefined };
  if (!("cycle" in settled)) {
    owe(folder, files);
    const output = `The watch opened no cycle for the turn within ${gate.timeoutSeconds} s, so not judged. Make it faster, or move it to CI.`;
    return { name, ok: false, ms, output, report: undefined, timedOut: true };
  }
  // Paid, less what a stop out of time meanwhile added: only the lists this stop asked for.
  for (const list of owed.lists) rmSync(list, { force: true });
  const judged = judgeCycle(gate, settled.cycle, baseline, asked);
  return { name, ms, ...judged, report: judged.ok ? settled.cycle : undefined };
}

/** The verdict of a cycle: its failed lines, or for a compared gate, the lines it added to the report of the turn start. */
function judgeCycle(
  gate: WatchedGate,
  cycle: string,
  baseline: string | undefined,
  files: string[],
): { ok: boolean; output: string } {
  const fails = new RegExp(gate.watch.failed ?? "(?!)");
  return isCompared(gate)
    ? addedLines(gate, cycle, baseline, files)
    : { ok: !cycle.split("\n").some((line) => fails.test(line)), output: cycle };
}

/**
 * The report a compared watch gives the turn start: a cycle it opens once asked, in the time a prompt can wait.
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
    process.kill(-Number(processOf(folder)), "SIGTERM");
  } catch {}
}

/**
 * The supervisor of a watch, which this module runs as when the engine starts one: it runs the watch and stops it
 * with every process it started once its repo has had no prompt nor stop for the idle delay. Started detached, it
 * leads a process group of its own, so stopping the group stops the watch and the tools under it. It counts the
 * cycles of the watch as it prints them, and keeps only the lines a hook reads: a watch prints thousands of lines per
 * cycle for as long as a session lasts, which no hook could read again at each look.
 */
function supervise(folder: string, idle: number, cycle: { start: string; end: string }, command: string[]): void {
  const [file = "", ...args] = command;
  const opens = new RegExp(cycle.start);
  const closes = new RegExp(cycle.end);
  const watch = spawn(file, args, { stdio: ["ignore", "pipe", "pipe"] });
  // The start of the watch opens the first cycle, and lines after the one that closes a cycle still belong to it. A
  // line that opens a cycle while one is open belongs to that one: Angular says it rebuilds as it starts to, and
  // again once it has, and counting both would end a cycle before its first line.
  let opened = 0;
  let open = true;
  // The lines of the cycle in progress, less the ones that say it opened, which tell the agent nothing.
  let lines: string[] = [];
  // What a watch that stopped leaves the agent.
  const last: string[] = [];
  const count = () => writeWhole(join(folder, "cycles"), `${opened} ${open ? "open" : "closed"}`);
  const read = (line: string) => {
    last.push(line);
    if (last.length > LAST_LINES) last.shift();
    if (closes.test(line)) {
      if (open) {
        open = false;
        count();
      }
    } else if (!open && opens.test(line)) {
      // Nothing is printed in a cycle any more once the next one has opened: its lines are whole, and written before
      // the count that tells a hook of them.
      writeWhole(join(folder, "cycle"), lines.join("\n"));
      lines = [];
      opened++;
      open = true;
      count();
    }
    if (!opens.test(line)) lines.push(line);
  };
  const end = (code: number) => {
    writeWhole(join(folder, "last"), last.join("\n"));
    process.exit(code);
  };
  count();
  createInterface({ input: watch.stdout }).on("line", read);
  createInterface({ input: watch.stderr }).on("line", read);
  watch.on("error", (error) => {
    last.push(error.message);
    end(1);
  });
  watch.on("close", (code) => end(code ?? 1));
  setInterval(
    () => {
      if (Date.now() - changedAt(join(folder, "activity")) < idle) return;
      writeFileSync(join(folder, "idle"), "");
      process.kill(-process.pid, "SIGTERM");
    },
    Math.min(idle / 4, 10_000),
  );
}

if (import.meta.main) {
  const [folder = "", idle = "", start = "", end = "", ...command] = process.argv.slice(2);
  supervise(folder, Number(idle), { start, end }, command);
}
