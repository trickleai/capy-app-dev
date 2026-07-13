import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import { isCodeSnapshotListResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { CodeSnapshotInfo, CodeSnapshotListResponse } from "../types.ts";

/**
 * List the project's source snapshots (newest-first). These are the code
 * versions recorded by `save` and by `deploy`'s auto-save; the human-readable
 * `message` is how you pick which one to `restore` to.
 */
export async function runSnapshots(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) {
    throw new CliError("Usage: capy-app-dev snapshots [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();

  const response = await apiRequest<CodeSnapshotListResponse>(api, {
    method: "GET",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/code/snapshots`,
  });

  if (!isCodeSnapshotListResponse(response)) {
    throw new CliError("Unexpected response from snapshots API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({ success: true, appName: config.appName, snapshots: response.snapshots });
    return;
  }

  if (response.snapshots.length === 0) {
    process.stdout.write('No snapshots. Run `save -m "..."` or `deploy -m "..."` first.\n');
    return;
  }

  writeHumanTable(response.snapshots);
}

function writeHumanTable(snapshots: readonly CodeSnapshotInfo[]): void {
  const rows = snapshots.map((s) => [s.id, s.createdAt, String(s.fileCount), s.message ?? ""]);
  const header = ["SNAPSHOT_ID", "CREATED_AT", "FILES", "MESSAGE"];
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
