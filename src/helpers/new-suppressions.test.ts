import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { newSuppressions } from "./new-suppressions.ts";

describe("newSuppressions", () => {
  test("finds the suppressions of each language the turn added, with their line", () => {
    const after = [
      "const a = 1;",
      "// eslint-disable-next-line no-console",
      "// @ts-expect-error",
      "import os  # noqa: F401",
      "x = 1  # type: ignore",
      "//nolint:errcheck",
      "// prettier-ignore",
      "/* stylelint-disable-next-line color-named */",
    ].join("\n");
    assert.deepEqual(
      newSuppressions("const a = 1;", after).map(({ line }) => line),
      [2, 3, 4, 5, 6, 7, 8],
    );
  });

  test("leaves the suppressions already there as the turn started, moved or not", () => {
    const before = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const after = "const b = 2;\n// eslint-disable-next-line no-console\nconsole.log(1);\n";
    assert.deepEqual(newSuppressions(before, after), []);
  });

  test("finds a suppression that says the same as one already there", () => {
    const before = "// eslint-disable-next-line no-console\nconsole.log(1);\n";
    const after = `${before}// eslint-disable-next-line no-console\nconsole.log(2);\n`;
    assert.deepEqual(
      newSuppressions(before, after).map(({ line }) => line),
      [3],
    );
  });

  test("leaves a suppression at the end of a line the turn changed", () => {
    assert.deepEqual(newSuppressions("x = f(a)  # noqa: E501\n", "x = f(a, b)  # noqa: E501\n"), []);
  });

  test("counts every suppression of a new file", () => {
    assert.deepEqual(newSuppressions(undefined, "# noqa\nprint(1)\n"), [{ line: 1, text: "# noqa" }]);
  });

  test("ignores the words of ordinary code", () => {
    assert.deepEqual(newSuppressions("", "const ignore = { type: 'x' };\nfunction disable() {}\n"), []);
  });
});
