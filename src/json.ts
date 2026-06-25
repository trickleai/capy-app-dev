import { isRecord } from "./guards.ts";
import type { JsonParseResult } from "./types.ts";

export function parseJson(rawValue: string): JsonParseResult {
  try {
    return { ok: true, value: JSON.parse(rawValue) as unknown };
  } catch {
    return { ok: false };
  }
}

export function readApiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }

    if (typeof payload.error === "string") {
      return payload.error;
    }
  }

  return `Request failed with status ${status}`;
}

export function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
