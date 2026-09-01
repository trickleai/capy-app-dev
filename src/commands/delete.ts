import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isDeleteResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { DeleteResponse } from "../types.ts";
import { validateAppName } from "../validation.ts";

/**
 * Delete an explicitly named app or the current project's app.
 *
 * Default (soft-delete): stops the worker and removes routing; D1 data and the
 * registry row are kept. Requires `--yes`.
 *
 * Hard-delete (`--hard`): irreversibly removes ALL app resources — CF scripts,
 * KV routing, D1 database, deployment history, env vars, and the registry row
 * (the app name is released for reuse). Requires `--hard --yes`.
 */
export async function runDelete(args: string[], json: boolean): Promise<void> {
  const knownFlags = new Set(["--yes", "-y", "--hard"]);
  const positional = args.filter((arg) => !knownFlags.has(arg) && !arg.startsWith("-"));
  const hasUnknownFlag = args.some((arg) => arg.startsWith("-") && !knownFlags.has(arg));
  const confirmed = args.some((arg) => arg === "--yes" || arg === "-y");
  const hard = args.includes("--hard");

  if (hasUnknownFlag || positional.length > 1) {
    throw new CliError("Usage: capy-app-dev delete [appName] [--hard] [--yes]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const explicitAppName = positional[0]?.trim();
  if (positional.length === 1) {
    validateAppName(explicitAppName ?? "");
  }

  const fromProjectConfig = explicitAppName === undefined;
  const appName = explicitAppName ?? (await readProjectConfig(process.cwd())).appName;

  if (!confirmed) {
    const warning = hard
      ? `This permanently and irreversibly deletes "${appName}" including its D1 database and all data. This cannot be undone. Re-run with --hard --yes to confirm.`
      : `This permanently stops "${appName}" and removes its URL. Re-run with --yes to confirm.`;
    throw new CliError(warning, { code: "CONFIRMATION_REQUIRED", exitCode: 2 });
  }

  const api = await getApiContext();
  const response = await apiRequest<DeleteResponse>(api, {
    method: "DELETE",
    pathname: `/api/apps/${encodeURIComponent(appName)}`,
    json: hard ? { hard: true } : undefined,
  });

  if (!isDeleteResponse(response)) {
    throw new CliError("Unexpected response from delete API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({
      success: true,
      appName: response.appName,
      status: response.status,
    });
    return;
  }

  if (hard) {
    process.stdout.write(
      `Hard-deleted app "${response.appName}" — all resources permanently removed.\n`,
    );
  } else {
    process.stdout.write(`Deleted app "${response.appName}" (status: ${response.status})\n`);
    if (fromProjectConfig) {
      process.stdout.write(
        "Note: .capy-app.json still references this app; remove it if you no longer need the link.\n",
      );
    }
  }
}
