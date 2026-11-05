import { readFileSync } from "node:fs";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

/** The message of whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What the text holds as JSON, or nothing when it is not JSON. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What the file holds as JSON, or nothing when it cannot be read or is not JSON. */
export function readJsonFile(path: string): unknown {
  try {
    return parseJson(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}
