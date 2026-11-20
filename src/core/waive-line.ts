// The waive line on its own, with no import: the engine reads it, and the display hooks of Claude Code hide it, the mod
// among them, which runs with no Node.

/** The tag that opens a waive line: the plugin's name, so the display can hide the line without hiding anything else. */
export const WAIVE_TAG = "deterministic-gates";

// A markdown link reference definition, which Codex hides: [deterministic-gates:<gate>]: waive "<reason>". The
// reason may also sit between single quotes or parentheses, as a link title may.
const WAIVE_SOURCE = `^ {0,3}\\[${WAIVE_TAG}:([^\\]\\s]+)\\]:[ \\t]*waive[ \\t]+(?:"([^"]*)"|'([^']*)'|\\(([^)]*)\\))[ \\t]*$`;

/** Every waive line of a text, its gate and its reason captured. */
export function waiveLines(): RegExp {
  return new RegExp(WAIVE_SOURCE, "gm");
}

/** The text with its waive lines taken out, line ending included; the same text when it holds none. */
export function hideWaives(text: string): string {
  return text.replace(new RegExp(`${WAIVE_SOURCE}\\r?\\n?`, "gm"), "");
}
