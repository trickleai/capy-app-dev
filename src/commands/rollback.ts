import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isRollbackResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { RollbackResponse } from "../types.ts";

export async function runRollback(args: string[], json: boolean): Promise<void> {
  const positional: string[] = [];
  for (const arg of args) {
    positional.push(arg);
  }

  if (positional.length === 0) {
    throw new CliError("Usage: capy-app-dev rollback <deployId>", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  if (positional.length > 1) {
    throw new CliError("Usage: capy-app-dev rollback <deployId>", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const deployId = positional[0];
  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const response = await apiRequest<RollbackResponse>(api, {
    method: "POST",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/rollback`,
    json: { deployId },
  });

  if (!isRollbackResponse(response)) {
    throw new CliError("Unexpected response from rollback API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({
      success: true,
      appName: response.appName,
      deployId: response.deployId,
      url: response.url,
    });
    return;
  }

  process.stdout.write(
    `Rolled back ${response.appName} to ${response.deployId} — live at ${response.url}\n`,
  );
}
