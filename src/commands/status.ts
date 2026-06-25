import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { writeJson } from "../json.ts";
import type { AppStatusResponse } from "../types.ts";

export async function runStatus(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: capy-app-dev status", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const api = await getApiContext();
  const config = await readProjectConfig(process.cwd());
  const response = await apiRequest<AppStatusResponse>(api, {
    method: "GET",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}`,
  });

  if (json) {
    writeJson({
      success: true,
      appName: response.app.appName,
      url: response.app.url,
      createdAt: response.app.createdAt,
      deployment: response.app.deployment,
      database: response.app.database,
    });
    return;
  }

  process.stdout.write(`App: ${response.app.appName}\n`);
  process.stdout.write(`URL: ${response.app.url}\n`);
  process.stdout.write(`Created: ${response.app.createdAt}\n`);
  process.stdout.write(`Last deployed: ${response.app.deployment?.deployedAt ?? "never"}\n`);
  if (response.app.deployment) {
    process.stdout.write(`Version: ${response.app.deployment.version}\n`);
  }
  if (response.app.database) {
    process.stdout.write(`Database: ${response.app.database.name}\n`);
  }
}
