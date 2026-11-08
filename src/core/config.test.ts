import assert from "node:assert/strict";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { tempRepo } from "../testing.ts";
import { configuredRoot, parseGates, readGates } from "./config.ts";

const lint = { name: "lint", severity: "error", files: "\\.ts$", run: ["eslint"] };

function file(...gates: object[]): string {
  return JSON.stringify({ gates });
}

describe("parseGates", () => {
  test("leaves out the gates turned off, and gives each a timeout", () => {
    const text = file(lint, { name: "dead", severity: "off", files: "\\.ts$", run: ["knip"] });
    assert.deepEqual(parseGates(text), [{ ...lint, timeoutSeconds: 45 }]);
  });

  test("keeps the optional fields it is given", () => {
    const dead = { ...lint, name: "dead", compare: "turn-start", ignoreLines: "\\(\\d+\\)$", timeoutSeconds: 10 };
    assert.deepEqual(parseGates(file(dead)), [dead]);
  });

  test("refuses an unknown severity or field, and a file with another shape", () => {
    assert.throws(() => parseGates(file({ ...lint, severity: "fatal" })));
    assert.throws(() => parseGates(file({ ...lint, extra: 1 })), /unknown field extra/);
    assert.throws(() => parseGates(JSON.stringify({ invariants: [lint] })), /holds "gates", a list of gates/);
    assert.throws(() => parseGates("[]"), /holds "gates", a list of gates/);
  });

  test("leaves out a gate with a problem of its own and keeps the others, as a check reads them", () => {
    const read = readGates(
      file({ ...lint, name: "broken", extra: 1 }, lint, { ...lint, name: "off", severity: "off", x: 1 }),
    );
    assert.deepEqual(
      read.gates.map(({ name }) => name),
      ["lint"],
    );
    assert.deepEqual(read.refused, [{ name: "broken", why: "unknown field extra" }]);
  });

  test("names the file it cannot read as JSON", () => {
    assert.throws(() => parseGates("{"), /^Error: \.gates\.json is not valid JSON/);
    assert.throws(() => parseGates(file(lint), "{"), /^Error: \.gates\.local\.json is not valid JSON/);
  });

  test("refuses a warning, which sends nobody back to fix it", () => {
    assert.throws(() => parseGates(file({ ...lint, severity: "warn" })), /a warning sends nobody back/);
  });

  test("gives a gate the time of the check, 45 seconds unless the repo says otherwise, and never more", () => {
    assert.equal(parseGates(file({ ...lint, timeoutSeconds: 60 }))[0]?.timeoutSeconds, 45);
    const slower = JSON.stringify({ gates: [{ ...lint, timeoutSeconds: 45 }], maxTimeoutSeconds: 60 });
    assert.equal(parseGates(slower)[0]?.timeoutSeconds, 45);
  });

  test("takes the time of the check from the local file over the shared one", () => {
    const shared = JSON.stringify({ gates: [lint], maxTimeoutSeconds: 60 });
    assert.equal(parseGates(shared, JSON.stringify({ maxTimeoutSeconds: 10 }))[0]?.timeoutSeconds, 10);
    assert.throws(() => parseGates(file(lint), JSON.stringify({ maxTimeoutSeconds: "30" })), /positive number/);
  });

  test("refuses a compared gate given the files, since it reads the whole project", () => {
    const dead = { ...lint, run: ["knip", "{files}"], compare: "turn-start" };
    assert.throws(() => parseGates(file(dead)), /takes no \{files\}/);
  });

  test("refuses a files or ignoreLines pattern that is not a regular expression", () => {
    assert.throws(() => parseGates(file({ ...lint, files: "(" })), /files is a regular expression/);
    assert.throws(() => parseGates(file({ ...lint, ignoreLines: "(" })), /ignoreLines is a regular expression/);
  });

  test("changes only the fields a local entry gives to the shared gate of its name", () => {
    assert.deepEqual(parseGates(file(lint), file({ name: "lint", timeoutSeconds: 10 })), [
      { ...lint, timeoutSeconds: 10 },
    ]);
  });

  test("turns a shared gate off from the local file", () => {
    assert.deepEqual(parseGates(file(lint), file({ name: "lint", severity: "off" })), []);
  });

  test("adds a local gate after the shared ones", () => {
    const own = { name: "own", severity: "error", files: "\\.md$", run: ["markdownlint"] };
    assert.deepEqual(
      parseGates(file(lint), file(own)).map(({ name }) => name),
      ["lint", "own"],
    );
  });

  test("refuses a new local gate with a missing field", () => {
    assert.throws(() => parseGates(file(lint), file({ name: "own", severity: "error" })));
  });

  test("runs from the local file alone, or from nothing", () => {
    assert.deepEqual(
      parseGates(undefined, file(lint)).map(({ name }) => name),
      ["lint"],
    );
    assert.deepEqual(parseGates(undefined), []);
  });
});

describe("configuredRoot", () => {
  test("finds the repo from a folder inside it, only once it has a gates file", () => {
    const repo = realpathSync(tempRepo());
    try {
      assert.equal(configuredRoot(repo), undefined);
      writeFileSync(join(repo, ".gates.local.json"), file(lint));
      assert.equal(configuredRoot(repo), repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("gives nothing outside git", () => {
    const folder = mkdtempSync(join(tmpdir(), "gates-no-git-"));
    try {
      assert.equal(configuredRoot(folder), undefined);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
