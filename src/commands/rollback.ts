import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isRollbackResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { RollbackResponse } from "../types.ts";

export async function runRollback(args: string[], json: boolean): Promise<void> {
  const positional: string[] = [];
  let yes = false;
  let withData = false;

  for (const arg of args) {
    if (arg === "--yes") {
      yes = true;
    } else if (arg === "--with-data") {
      withData = true;
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new CliError("Usage: capy-app-dev rollback <deployId> [--with-data] [--yes] [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  if (positional.length > 1) {
    throw new CliError("Usage: capy-app-dev rollback <deployId> [--with-data] [--yes] [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  if (withData && !yes) {
    throw new CliError(
      "rollback --with-data is destructive (overwrites D1 data). Re-run with --yes to confirm.",
      {
        code: "CONFIRMATION_REQUIRED",
        exitCode: 2,
      },
    );
  }

  const deployId = positional[0];
  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const body: { deployId: string; withData?: true } = { deployId };
  if (withData) {
    body.withData = true;
  }

  const response = await apiRequest<RollbackResponse>(api, {
    method: "POST",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/rollback`,
    json: body,
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
      withData: response.withData ?? false,
    });
    return;
  }

  if (withData) {
    process.stdout.write(
      `Rolled back ${response.appName} to ${response.deployId} — live at ${response.url}\nNote: D1 database restored to that version's snapshot.\n`,
    );
  } else {
    process.stdout.write(
      `Rolled back ${response.appName} to ${response.deployId} — live at ${response.url}\n`,
    );
  }
}
