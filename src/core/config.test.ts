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

  test("names every pass only when asked, with the local file over the shared one", () => {
    assert.equal(readGates(file(lint)).showAllPasses, false);
    const shared = JSON.stringify({ gates: [lint], showAllPasses: true });
    assert.equal(readGates(shared).showAllPasses, true);
    assert.equal(readGates(shared, JSON.stringify({ showAllPasses: false })).showAllPasses, false);
    assert.throws(() => readGates(file(lint), JSON.stringify({ showAllPasses: "yes" })), /true or false/);
  });

  test("sends the agent back 5 times a turn unless told otherwise, with the local file over the shared one", () => {
    assert.equal(readGates(file(lint)).maxSendBacks, 5);
    const shared = JSON.stringify({ gates: [lint], maxSendBacks: 2 });
    assert.equal(readGates(shared).maxSendBacks, 2);
    assert.equal(readGates(shared, JSON.stringify({ maxSendBacks: 0 })).maxSendBacks, 0);
    for (const wrong of [-1, 1.5, "3"])
      assert.throws(() => readGates(file(lint), JSON.stringify({ maxSendBacks: wrong })), /whole number, 0 or more/);
  });

  test("keeps 4000 characters of a report unless the repo or the gate says otherwise, the gate first", () => {
    assert.equal(parseGates(file(lint))[0]?.maxReportChars, undefined);
    const shared = JSON.stringify({
      gates: [lint, { ...lint, name: "clones", maxReportChars: 800 }],
      maxReportChars: 2000,
    });
    assert.deepEqual(
      parseGates(shared).map(({ maxReportChars }) => maxReportChars),
      [2000, 800],
    );
    assert.equal(parseGates(shared, JSON.stringify({ maxReportChars: 500 }))[0]?.maxReportChars, 500);
    for (const wrong of [0, 1.5, "300"]) {
      assert.throws(
        () => parseGates(JSON.stringify({ gates: [lint], maxReportChars: wrong })),
        /maxReportChars is a whole number/,
      );
      assert.throws(() => parseGates(file({ ...lint, maxReportChars: wrong })), /maxReportChars is a whole number/);
    }
  });

  test("reads the exit codes that mean a gate broke", () => {
    assert.deepEqual(parseGates(file({ ...lint, brokenExitCodes: [2] }))[0]?.brokenExitCodes, [2]);
    for (const wrong of [2, ["2"], [1.5], [0]])
      assert.throws(
        () => parseGates(file({ ...lint, brokenExitCodes: wrong })),
        /brokenExitCodes is a list of exit codes/,
      );
  });

  test("reads the lines of its report a gate never sends the agent", () => {
    assert.equal(parseGates(file({ ...lint, omitLines: "^\\s+at " }))[0]?.omitLines, "^\\s+at ");
    assert.throws(() => parseGates(file({ ...lint, omitLines: "(" })), /omitLines is a regular expression/);
  });

  test("sends 4000 characters of reports at most unless told otherwise, with the local file over the shared one", () => {
    assert.equal(readGates(file(lint)).maxTotalReportChars, 4000);
    const shared = JSON.stringify({ gates: [lint], maxTotalReportChars: 6000 });
    assert.equal(readGates(shared).maxTotalReportChars, 6000);
    assert.equal(readGates(shared, JSON.stringify({ maxTotalReportChars: 900 })).maxTotalReportChars, 900);
    for (const wrong of [0, 1.5, "300"])
      assert.throws(
        () => readGates(JSON.stringify({ maxTotalReportChars: wrong })),
        /maxTotalReportChars is a whole number/,
      );
  });

  test("reads the prompt of a gate: a text to add to what the agent is told, or one to replace it", () => {
    const [added] = parseGates(file({ ...lint, prompt: "Never edit src/generated." }));
    assert.deepEqual(added?.prompt, { text: "Never edit src/generated.", replace: false });
    const [replaced] = parseGates(file({ ...lint, prompt: { replace: "Waive it." } }));
    assert.deepEqual(replaced?.prompt, { text: "Waive it.", replace: true });
    for (const wrong of [1, "", { replace: 1 }, { replace: "x", add: "y" }])
      assert.throws(() => parseGates(file({ ...lint, prompt: wrong })), /prompt is a text to add/);
  });

  test("reads the prompts of the whole check, each key of the local file over the shared one", () => {
    assert.deepEqual(readGates(file(lint)).prompts, {});
    const shared = JSON.stringify({ gates: [lint], prompts: { sendBack: "Ask first.", missingTools: "Use pnpm." } });
    const local = JSON.stringify({ prompts: { sendBack: { replace: "Stop." } } });
    assert.deepEqual(readGates(shared, local).prompts, {
      sendBack: { text: "Stop.", replace: true },
      missingTools: { text: "Use pnpm.", replace: false },
    });
    assert.throws(() => readGates(JSON.stringify({ prompts: { conduct: "x" } })), /prompts holds "sendBack"/);
    assert.throws(() => readGates(JSON.stringify({ prompts: { sendBack: 1 } })), /prompts.sendBack is a text to add/);
  });

  test("refuses a compared gate given the files, since it reads the whole project", () => {
    const dead = { ...lint, run: ["knip", "{files}"], compare: "turn-start" };
    assert.throws(() => parseGates(file(dead)), /takes no \{files\}/);
  });

  test("refuses a files, ignoreLines or lineKey pattern that is not a regular expression, and a lineKey with no compare", () => {
    assert.throws(() => parseGates(file({ ...lint, files: "(" })), /files is a regular expression/);
    assert.throws(() => parseGates(file({ ...lint, ignoreLines: "(" })), /ignoreLines is a regular expression/);
    const compared = { ...lint, run: ["knip"], compare: "turn-start" };
    assert.throws(() => parseGates(file({ ...compared, lineKey: "(" })), /lineKey is a regular expression/);
    assert.throws(
      () => parseGates(file({ ...lint, lineKey: "^[^\\t]*" })),
      /lineKey tells apart the lines of a compared gate/,
    );
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
