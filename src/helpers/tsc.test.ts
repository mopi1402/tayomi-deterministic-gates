import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, describe, test } from "node:test";
import { nothingChecked } from "./tsc.ts";

// A project as Angular lays it out: a tsconfig.json that only references the ones of the app and of the specs.
const root = mkdtempSync(join(tmpdir(), "gates-tsc-"));
mkdirSync(join(root, "node_modules"));
symlinkSync(
  resolve(import.meta.dirname, "..", "..", "node_modules", "typescript"),
  join(root, "node_modules", "typescript"),
);
mkdirSync(join(root, "src"));
writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
writeFileSync(
  join(root, "tsconfig.json"),
  `/* Angular writes a comment here. */
{
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }, { "path": "./tsconfig.spec.json" }],
}
`,
);
writeFileSync(join(root, "tsconfig.app.json"), JSON.stringify({ include: ["src/**/*.ts"] }));
writeFileSync(join(root, "tsconfig.spec.json"), JSON.stringify({ include: ["src/**/*.spec.ts"] }));

describe("tsc, as a gate runs it", () => {
  after(() => rmSync(root, { recursive: true, force: true }));

  test("refuses a tsconfig that checks no file, since it only references others, and names them", () => {
    assert.equal(
      nothingChecked(root, ["--noEmit"]),
      "tsconfig.json checks no file: it only references tsconfig.app.json and tsconfig.spec.json. Add -p and the one to check to the gate's run.",
    );
  });

  test("runs the tsconfig the gate names, which checks files", () => {
    assert.equal(nothingChecked(root, ["-p", "tsconfig.app.json"]), undefined);
    assert.equal(nothingChecked(root, ["--project", "tsconfig.app.json"]), undefined);
  });
});
