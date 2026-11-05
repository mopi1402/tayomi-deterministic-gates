import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";

const CLI = join(import.meta.dirname, "cli.ts");

let repo = "";

function cli(...args: string[]) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [CLI, ...args], { cwd: repo, encoding: "utf8" });
  return { status, stdout: stripVTControlCharacters(stdout), stderr };
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gates-cli-"));
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("check", () => {
  test("reports every gate on the whole repo, then each failed report, and exits with 1", () => {
    writeFileSync(join(repo, "fail.mjs"), 'console.log("a problem"); process.exit(1)');
    writeFileSync(join(repo, "pass.mjs"), "");
    writeFileSync(join(repo, "a.ts"), "1");
    writeFileSync(
      join(repo, ".gates.json"),
      JSON.stringify({
        gates: [
          { name: "red", severity: "error", files: "\\.ts$", run: ["fail.mjs"] },
          { name: "green", severity: "error", files: "\\.ts$", run: ["pass.mjs"] },
        ],
      }),
    );
    const { status, stdout } = cli("check");
    assert.equal(status, 1);
    assert.match(stdout, /1\/2 gates green/);
    assert.match(stdout, /## red\na problem/);
    assert.doesNotMatch(stdout, /agent/);
  });

  test("exits with 0 when every gate is green", () => {
    writeFileSync(join(repo, "pass.mjs"), "");
    writeFileSync(join(repo, "a.ts"), "1");
    writeFileSync(
      join(repo, ".gates.json"),
      JSON.stringify({ gates: [{ name: "green", severity: "error", files: "\\.ts$", run: ["pass.mjs"] }] }),
    );
    const { status, stdout } = cli("check");
    assert.equal(status, 0);
    assert.match(stdout, /1\/1 gates green/);
  });

  test("says so outside git, and exits with 2", () => {
    rmSync(join(repo, ".git"), { recursive: true, force: true });
    const { status, stderr } = cli("check");
    assert.equal(status, 2);
    assert.match(stderr, /not in a git repository/i);
  });
});
