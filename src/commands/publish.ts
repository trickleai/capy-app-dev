import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isPublishResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { PublishResponse } from "../types.ts";

interface PublishOptions {
  deployId?: string;
  withData: boolean;
}

const PUBLISH_USAGE =
  "Usage: capy-app-dev publish [deployId] [--json]\n" +
  "       capy-app-dev publish <deployId> --with-data --yes [--json]";

function invalidUsage(): CliError {
  return new CliError(PUBLISH_USAGE, { code: "INVALID_USAGE", exitCode: 2 });
}

function parsePublishArgs(args: readonly string[]): PublishOptions {
  let deployId: string | undefined;
  let withData = false;
  let yes = false;

  for (const arg of args) {
    if (arg === "--with-data") {
      if (withData) {
        throw invalidUsage();
      }
      withData = true;
    } else if (arg === "--yes") {
      if (yes) {
        throw invalidUsage();
      }
      yes = true;
    } else if (arg.startsWith("-") || deployId !== undefined || arg.trim().length === 0) {
      throw invalidUsage();
    } else {
      deployId = arg;
    }
  }

  if (withData && deployId === undefined) {
    throw invalidUsage();
  }
  if (yes && !withData) {
    throw invalidUsage();
  }
  if (withData && !yes) {
    throw new CliError(
      "Publishing with data is destructive. Re-run with --with-data --yes to confirm.",
      { code: "CONFIRMATION_REQUIRED", exitCode: 2 },
    );
  }

  return { deployId, withData };
}

export async function runPublish(args: string[], json: boolean): Promise<void> {
  const { deployId, withData } = parsePublishArgs(args);
  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const body: { deployId?: string; withData?: true } = {};
  if (deployId !== undefined) {
    body.deployId = deployId;
  }
  if (withData) {
    body.withData = true;
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
      withData: response.withData,
      codePublished: response.codePublished,
      dataRestored: response.dataRestored,
    });
    return;
  }

  process.stdout.write(`Published ${response.appName} — live at ${response.url}\n`);
  if (response.withData) {
    process.stdout.write("D1 data restored to the target deployment bookmark.\n");
  }
}
