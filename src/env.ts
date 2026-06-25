import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isRecord } from "./guards.ts";
import { parseJson } from "./json.ts";

export function getFirstConfiguredEnvValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

/**
 * Read the CLI version from package.json. Both the bundled `dist/index.js` and
 * the source `src/index.ts` sit one level below the package root, so
 * `../package.json` resolves correctly in production and in tests alike. Falls
 * back to "unknown" if the file can't be read or parsed.
 */
export async function readPackageVersion(): Promise<string> {
  try {
    const packageJsonPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "..",
      "package.json",
    );
    const parsed = parseJson(await readFile(packageJsonPath, "utf8"));
    if (parsed.ok && isRecord(parsed.value) && typeof parsed.value.version === "string") {
      return parsed.value.version;
    }
  } catch {
    // fall through to the fallback below
  }
  return "unknown";
}
