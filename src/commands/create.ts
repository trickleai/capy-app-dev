import path from "node:path";

import { apiRequest, getApiContext } from "../api.ts";
import { CONFIG_FILE_NAME } from "../constants.ts";
import { CliError } from "../errors.ts";
import { pathExists, writeJsonFile } from "../fs-utils.ts";
import { writeJson } from "../json.ts";
import type { CreateAppResponse, ProjectConfig } from "../types.ts";
import { validateAppName } from "../validation.ts";

export async function runCreate(args: string[], json: boolean): Promise<void> {
  if (args.length !== 1) {
    throw new CliError("Usage: capy-app-dev create <app-name>", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const appName = args[0].trim();
  if (!appName) {
    throw new CliError("app name is required", { code: "INVALID_APP_NAME", exitCode: 2 });
  }

  validateAppName(appName);

  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  if (await pathExists(configPath)) {
    throw new CliError(
      `Found existing ${CONFIG_FILE_NAME}. This directory is already linked to an app.`,
      { code: "CONFIG_ALREADY_EXISTS" },
    );
  }

  const api = await getApiContext({ requireUserId: true });

  const response = await apiRequest<CreateAppResponse>(api, {
    method: "POST",
    pathname: "/api/apps",
    json: {
      appName,
      userId: api.userId,
    },
  });

  const config: ProjectConfig = {
    appName: response.app.appName,
    url: response.app.url,
    createdAt: response.app.createdAt,
  };

  await writeJsonFile(configPath, config);

  if (json) {
    writeJson({
      success: true,
      appName: config.appName,
      url: config.url,
      createdAt: config.createdAt,
    });
    return;
  }

  process.stdout.write(`Creating app "${config.appName}"... done\n`);
  process.stdout.write(`URL: ${config.url}\n`);
}
