import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isVersionsResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { VersionEntry, VersionsResponse } from "../types.ts";

export async function runVersions(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: capy-app-dev versions [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const response = await apiRequest<VersionsResponse>(api, {
    method: "GET",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/versions`,
  });

  if (!isVersionsResponse(response)) {
    throw new CliError("Unexpected response from versions API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({ success: true, appName: response.appName, versions: response.versions });
    return;
  }

  if (response.versions.length === 0) {
    process.stdout.write("No versions.\n");
    return;
  }

  writeHumanTable(response.versions);
}

function writeHumanTable(versions: readonly VersionEntry[]): void {
  const rows = versions.map((v) => [v.deployId, v.status, v.version, v.previewUrl, v.createdAt]);
  const header = ["DEPLOY_ID", "STATUS", "VERSION", "PREVIEW_URL", "CREATED_AT"];
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();

  process.stdout.write(`${line(header)}\n`);
  for (const row of rows) {
    process.stdout.write(`${line(row)}\n`);
  }
}
