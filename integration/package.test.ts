import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { stripVTControlCharacters } from "node:util";

// The engine as npm ships it: built, packed, installed in a project of its own, then run by its bin. Node strips no type
// under node_modules, so the package runs the built .js, its {engine} scripts included.

const ENGINE = join(import.meta.dirname, "..");

let work = "";
let bin = "";

function inRepo(repo: string, files: Record<string, string>): void {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  for (const [file, text] of Object.entries(files)) writeFileSync(join(repo, file), text);
}

function check(repo: string) {
  const { status, stdout, stderr } = spawnSync(bin, ["check"], { cwd: repo, encoding: "utf8" });
  return { status, stdout: stripVTControlCharacters(stdout), stderr };
}

before(() => {
  work = mkdtempSync(join(tmpdir(), "gates-package-"));
  execFileSync("pnpm", ["-s", "build"], { cwd: ENGINE, stdio: "inherit" });
  const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], {
    cwd: ENGINE,
    encoding: "utf8",
  });
  const project = join(work, "project");
  mkdirSync(project);
  writeFileSync(join(project, "package.json"), "{}");
  const install = ["install", "--offline", "--no-audit", "--no-fund", "--ignore-scripts", join(work, tarball.trim())];
  execFileSync("npm", install, { cwd: project, stdio: "inherit" });
  bin = join(project, "node_modules", ".bin", "deterministic-gates");
});

after(() => {
  rmSync(work, { recursive: true, force: true });
});

const GATES = JSON.stringify({
  gates: [
    {
      name: "no-new-suppressions",
      severity: "error",
      files: "\\.ts$",
      run: ["{engine}/src/helpers/new-suppressions.ts", "{turn}", "{files}"],
    },
  ],
});

describe("the npm package", () => {
  test("checks a repo through its bin, with a script of the engine", () => {
    const repo = join(work, "clean");
    mkdirSync(repo);
    inRepo(repo, { ".gates.json": GATES, "a.ts": "export const a = 1;\n" });
    const { status, stdout, stderr } = check(repo);
    assert.equal(status, 0, stdout + stderr);
    assert.match(stdout, /1\/1 gates green/);
  });

  test("fails on what the script of the engine finds", () => {
    const repo = join(work, "fault");
    mkdirSync(repo);
    inRepo(repo, { ".gates.json": GATES, "a.ts": "// @ts-ignore\nexport const a = 1;\n" });
    const { status, stdout } = check(repo);
    assert.equal(status, 1, stdout);
    assert.match(stdout, /a\.ts:1: \/\/ @ts-ignore/);
  });
});
