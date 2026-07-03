import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isPublishResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { PublishResponse } from "../types.ts";

export async function runPublish(args: string[], json: boolean): Promise<void> {
  const positional: string[] = [];
  for (const arg of args) {
    positional.push(arg);
  }

  if (positional.length > 1) {
    throw new CliError("Usage: capy-app-dev publish [deployId] [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const deployId = positional[0];
  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const body: Record<string, string> = {};
  if (deployId !== undefined) {
    body.deployId = deployId;
  }

  const response = await apiRequest<PublishResponse>(api, {
    method: "POST",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/publish`,
    json: body,
  });

  if (!isPublishResponse(response)) {
    throw new CliError("Unexpected response from publish API", {
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

  process.stdout.write(`Published ${response.appName} — live at ${response.url}\n`);
}
