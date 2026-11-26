import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, test } from "node:test";
import { snapshot } from "../core/snapshot.ts";
import { commitAll, git, tempRepo } from "../testing.ts";
import { newClones, turnClones, wroteIn } from "./new-clones.ts";

function clone(isNew: boolean | undefined, first: string, second: string) {
  return { isNew, firstFile: { name: first, start: 1, end: 9 }, secondFile: { name: second, start: 20, end: 28 } };
}

describe("newClones", () => {
  test("keeps only the clones the turn added, one line each", () => {
    const report = {
      duplicates: [clone(false, "old.ts", "older.ts"), clone(true, "a.tsx", "b.tsx"), clone(undefined, "c.ts", "d.ts")],
    };
    assert.deepEqual(newClones(report), ["a.tsx:1-9 ~ b.tsx:20-28"]);
  });

  test("leaves a clone jscpd calls new when the turn wrote in neither of its sides", () => {
    const report = { duplicates: [clone(true, "a.ts", "b.ts"), clone(true, "b.ts", "c.ts")] };
    assert.deepEqual(
      newClones(report, ({ name }) => name === "c.ts"),
      ["b.ts:1-9 ~ c.ts:20-28"],
    );
  });

  test("refuses a report it cannot read", () => {
    assert.throws(() => newClones({ clones: [] }));
    assert.throws(() => newClones({ duplicates: [{ isNew: true, firstFile: { name: "a.ts" } }] }));
  });
});

describe("wroteIn", () => {
  const text = ["import a;", "  one();", "  two();", "", "  three();", "end"].join("\n");
  // From the middle of the first line to the middle of the last, as jscpd cuts a clone between two tokens.
  const side = { start: { line: 1, column: 7 }, end: { line: 6, column: 2 } };

  test("is true for a line the turn wrote that stands whole in the clone", () => {
    assert.equal(wroteIn(side, text, [{ at: 3, lines: 1 }]), true);
    assert.equal(wroteIn({ ...side, end: { line: 6, column: 3 } }, text, [{ at: 6, lines: 1 }]), true);
  });

  test("is false for a line the clone only starts or ends in, for an empty one, and for one outside", () => {
    assert.equal(wroteIn(side, text, [{ at: 1, lines: 1 }]), false);
    assert.equal(wroteIn(side, text, [{ at: 6, lines: 1 }]), false);
    assert.equal(wroteIn(side, text, [{ at: 4, lines: 1 }]), false);
    assert.equal(wroteIn({ ...side, end: { line: 3, column: 8 } }, text, [{ at: 5, lines: 2 }]), false);
  });

  test("is true when the turn cut lines out of the middle of the clone, false when it cut them after it", () => {
    assert.equal(wroteIn(side, text, [{ at: 3, lines: 0 }]), true);
    assert.equal(wroteIn(side, text, [{ at: 6, lines: 0 }]), false);
  });
});

describe("turnClones, with jscpd", () => {
  const body = Array.from({ length: 14 }, (_, at) => `  const value${at} = compute(input${at}, ${at}) + offset${at};`);
  const imports = Array.from({ length: 16 }, (_, at) => `import { thing${at}, other${at} } from "./module-${at}.ts";`);
  const copy = (name: string) => [`export function ${name}(): number {`, ...body, `  return ${name.length};`, "}", ""];

  // cadd, loeuf and up2 hold the same function, and loeuf and revel the same imports. The turn starts once the repo
  // is prepared, from the commit the engine records of its working tree.
  const after = (act: (repo: string) => void, prepare: (repo: string) => void = () => {}) => {
    const repo = tempRepo();
    try {
      symlinkSync(join(import.meta.dirname, "..", "..", "node_modules"), join(repo, "node_modules"));
      writeFileSync(join(repo, ".gitignore"), "node_modules\n");
      writeFileSync(join(repo, ".jscpd.json"), JSON.stringify({ minTokens: 40, minLines: 5, gitignore: true }));
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, "src/cadd.ts"), copy("cadd").join("\n"));
      writeFileSync(join(repo, "src/loeuf.ts"), [...imports, "", ...copy("loeuf")].join("\n"));
      writeFileSync(join(repo, "src/up2.ts"), copy("up2").join("\n"));
      writeFileSync(join(repo, "src/revel.ts"), [...imports, "", "export const revel = 1;", ""].join("\n"));
      commitAll(repo, "start");
      prepare(repo);
      const turn = snapshot(repo).commit;
      act(repo);
      return turnClones(repo, turn);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  };

  test("finds no clone in a turn that changes nothing", () => {
    assert.deepEqual(
      after(() => {}),
      [],
    );
  });

  test("leaves the clone of two old files that jscpd pairs once the turn takes the copy out of a third", () => {
    assert.deepEqual(
      after((repo) => writeFileSync(join(repo, "src/cadd.ts"), "export const cadd = shared();\n")),
      [],
    );
  });

  test("leaves an old clone the turn only cut in two, by a line written in its middle", () => {
    const cut = after((repo) => {
      const lines = readFileSync(join(repo, "src/revel.ts"), "utf8").split("\n");
      lines.splice(12, 0, 'import { shared } from "./shared.ts";');
      writeFileSync(join(repo, "src/revel.ts"), lines.join("\n"));
    });
    assert.deepEqual(cut, []);
  });

  test("names the copy the turn writes in an old file whose name git would read as a pattern", () => {
    const named = after(
      (repo) => writeFileSync(join(repo, "src/[slug].ts"), ["export const slug = 1;", ...copy("slug")].join("\n")),
      (repo) => {
        writeFileSync(join(repo, "src/[slug].ts"), "export const slug = 1;\n");
        commitAll(repo, "a route");
      },
    );
    assert.ok(named.length);
    for (const line of named) assert.match(line, /src\/\[slug\]\.ts:\d+-\d+/);
  });

  test("names the copy the turn writes in a file an earlier turn created and nobody committed", () => {
    const named = after(
      (repo) => writeFileSync(join(repo, "src/draft.ts"), ["export const draft = 1;", ...copy("draft")].join("\n")),
      (repo) => writeFileSync(join(repo, "src/draft.ts"), "export const draft = 1;\n"),
    );
    assert.ok(named.length);
    for (const line of named) assert.match(line, /src\/draft\.ts:\d+-\d+/);
  });

  test("names the copy the turn writes whatever colours and diff program the git of the owner is set to", () => {
    for (const [key, value] of [
      ["color.ui", "always"],
      ["diff.external", "/bin/echo"],
    ]) {
      const named = after(
        (repo) => writeFileSync(join(repo, "src/up2.ts"), [...copy("up2"), ...copy("again")].join("\n")),
        (repo) => git(repo, ["config", key ?? "", value ?? ""]),
      );
      assert.ok(named.length, key);
    }
  });

  test("names the copy the turn writes, in a new file or in an old one", () => {
    const created = after((repo) => writeFileSync(join(repo, "src/fresh.ts"), copy("fresh").join("\n")));
    assert.ok(created.length);
    for (const line of created) assert.match(line, /src\/fresh\.ts:\d+-\d+/);
    const appended = after((repo) =>
      writeFileSync(
        join(repo, "src/revel.ts"),
        [readFileSync(join(repo, "src/revel.ts"), "utf8"), ...copy("again")].join("\n"),
      ),
    );
    assert.ok(appended.length);
    for (const line of appended) assert.match(line, /src\/revel\.ts:\d+-\d+/);
  });
});
