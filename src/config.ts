import { readFile } from "node:fs/promises";
import path from "node:path";

import { CONFIG_FILE_NAME } from "./constants.ts";
import { CliError } from "./errors.ts";
import { isRecord } from "./guards.ts";
import { parseJson } from "./json.ts";
import type { ProjectConfig } from "./types.ts";

export async function readProjectConfig(cwd: string): Promise<ProjectConfig> {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(
      `No ${CONFIG_FILE_NAME} found. Run "capy-app-dev create <app-name>" first.`,
      { code: "MISSING_PROJECT_CONFIG" },
    );
  }

  const parsedConfig = parseJson(rawConfig);
  const config = parsedConfig.ok ? parsedConfig.value : undefined;
  if (!isRecord(config) || typeof config.appName !== "string" || typeof config.url !== "string") {
    throw new CliError(`${CONFIG_FILE_NAME} is invalid`, {
      code: "INVALID_PROJECT_CONFIG",
    });
  }

  return {
    appName: config.appName,
    url: config.url,
    createdAt: typeof config.createdAt === "string" ? config.createdAt : undefined,
  };
}
