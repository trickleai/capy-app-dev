import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { createDeployArchive } from "../deploy-archive.ts";
import { CliError } from "../errors.ts";
import { isDeployResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { DeployConfig, DeployResponse, PlainTextBinding } from "../types.ts";
import { requireMessage, saveWorkspace } from "./save.ts";

/** Parse `deploy` flags: [--dir <buildDir>] [-m|--message <msg>]. */
function parseDeployArgs(args: string[]): { dir?: string; message?: string } {
  const usage = () =>
    new CliError("Usage: capy-app-dev deploy [--dir <path>] -m <message> [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  const opts: { dir?: string; message?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--dir" || a === "-d") {
      opts.dir = args[++i];
      if (opts.dir === undefined) throw usage();
    } else if (a.startsWith("--dir=")) {
      opts.dir = a.slice("--dir=".length);
    } else if (a === "--message" || a === "-m") {
      opts.message = args[++i];
      if (opts.message === undefined) throw usage();
    } else if (a.startsWith("--message=")) {
      opts.message = a.slice("--message=".length);
    } else {
      throw usage();
    }
  }
  if (opts.dir !== undefined && opts.dir.trim() === "") throw usage();
  return opts;
}

/**
 * Translate the project's plain env vars into a deploy `config` payload. Each
 * entry becomes a Cloudflare `plain_text` binding, which the platform forwards
 * verbatim into the user worker's deploy metadata (so it is readable at runtime
 * via `env.<NAME>`). Returns null when there is nothing to send, so the caller
 * can omit the `config` field entirely and leave the request unchanged.
 */
export function buildDeployConfig(env: Record<string, string> | undefined): DeployConfig | null {
  if (!env) {
    return null;
  }

  const bindings: PlainTextBinding[] = Object.entries(env).map(([name, text]) => ({
    type: "plain_text",
    name,
    text,
  }));

  if (bindings.length === 0) {
    return null;
  }

  return { bindings };
}

export async function runDeploy(args: string[], json: boolean): Promise<void> {
  const opts = parseDeployArgs(args);
  // Deploy requires a message: it is reused as the source-snapshot message so
  // every deployed version has a findable, describable source snapshot.
  const message = requireMessage(opts.message);
  const api = await getApiContext();
  const config = await readProjectConfig(process.cwd());

  // Save the project SOURCE first (cwd, not the build dir) so this deploy is
  // bound to an exact code snapshot. The build output (dist) is a separate
  // artifact; source lives in the workspace root.
  //
  // Best-effort: source-snapshotting is an enhancement, not a gate. If the code
  // API is unavailable (older backend, transient failure), log and continue with
  // no snapshot binding — deploying the app must never be blocked by it. The
  // `-m` check above is a LOCAL requirement and still hard-fails.
  if (!json) {
    process.stdout.write("Saving project source...\n");
  }
  // The source snapshot is best-effort — a save failure never blocks the deploy
  // — but the outcome must be EXPLICIT, not silent. When the save is skipped the
  // deploy still succeeds with no bound snapshot, so surface `snapshotError` (and
  // `snapshotSaved: false` in --json) so the caller/agent knows this version has
  // no recoverable source snapshot instead of assuming one exists.
  let snapshotId: string | null = null;
  let snapshotError: string | null = null;
  try {
    const save = await saveWorkspace(api, config.appName, process.cwd(), message);
    snapshotId = save.snapshotId;
    if (!json) {
      process.stdout.write(`  snapshot ${save.snapshotId} (${save.fileCount} files)\n`);
    }
  } catch (error) {
    snapshotError = error instanceof Error ? error.message : String(error);
    if (!json) {
      process.stdout.write(`  (source snapshot skipped: ${snapshotError})\n`);
    }
  }

  const buildDir = path.resolve(process.cwd(), opts.dir ?? "dist");
  const deployPackage = await createDeployArchive(buildDir);

  try {
    if (!json) {
      process.stdout.write("Packaging build output...\n");
      if (deployPackage.workerEntry) {
        process.stdout.write(`  Worker entry: ${deployPackage.workerEntry}\n`);
      } else {
        process.stdout.write("  Worker entry: auto-generated asset worker\n");
      }
      if (deployPackage.assetsDirectory) {
        process.stdout.write(
          `  Assets directory: ${deployPackage.assetsDirectory} (${deployPackage.assetsCount} files)\n`,
        );
      } else {
        process.stdout.write("  Assets directory: none\n");
      }
      if (deployPackage.databaseMigrationsDirectory) {
        process.stdout.write(
          `  Database migrations: ${deployPackage.databaseMigrationsDirectory} (${deployPackage.databaseMigrationFiles} files)\n`,
        );
      } else {
        process.stdout.write("  Database migrations: none\n");
      }
      process.stdout.write(`Deploying to ${config.appName}...\n`);
    }

    const formData = new FormData();
    const archiveContents = await readFile(deployPackage.archivePath);
    formData.set(
      "archive",
      new File([archiveContents], deployPackage.archiveName, {
        type: "application/gzip",
      }),
    );

    // Plain env vars (if any) are translated into Cloudflare `plain_text`
    // bindings and sent in the `config` field — the only channel the backend
    // consumes (it forwards `config.bindings` into the worker's deploy
    // metadata). Validated in readProjectConfig; only send when non-empty.
    const deployConfig = buildDeployConfig(config.env);
    if (deployConfig) {
      formData.set("config", JSON.stringify(deployConfig));
    }

    // Bind this deploy to the source snapshot saved above (when one exists), so
    // the backend can record which code produced this version
    // (app_deployments.snapshot_id). Omitted when the save was skipped.
    if (snapshotId) {
      formData.set("snapshotId", snapshotId);
    }

    const response = await apiRequest<DeployResponse>(api, {
      method: "POST",
      pathname: `/api/apps/${encodeURIComponent(config.appName)}/deploy`,
      body: formData,
    });

    if (!isDeployResponse(response)) {
      throw new CliError("Unexpected response from deploy API", {
        code: "INVALID_API_RESPONSE",
      });
    }

    if (json) {
      writeJson({
        success: true,
        appName: response.deployment.appName,
        url: response.deployment.url,
        version: response.deployment.version,
        assetsCount: response.deployment.assetsCount,
        deployedAt: response.deployment.deployedAt,
        database: response.deployment.database ?? null,
        previewUrl: response.previewUrl,
        deployId: response.deployId,
        published: response.published,
        snapshotId,
        snapshotSaved: snapshotId !== null,
        snapshotError,
      });
      return;
    }

    process.stdout.write("Done\n\n");
    process.stdout.write("Deployment successful:\n");
    process.stdout.write(`  Version: ${response.deployment.version}\n`);
    process.stdout.write(`  Assets: ${response.deployment.assetsCount} files\n`);
    if (response.deployment.database) {
      process.stdout.write(
        `  Database: ${response.deployment.database.name} (${response.deployment.database.migrationsApplied} migrations applied)\n`,
      );
    }
    if (response.published) {
      process.stdout.write(
        `Deployed ${response.deployment.appName} — live at ${response.deployment.url}\nPreview: ${response.previewUrl}\n`,
      );
    } else {
      process.stdout.write(
        `Deployed ${response.deployment.appName} — preview at ${response.previewUrl}\nLive site unchanged. Run \`publish\` to go live.\n`,
      );
    }
    // Deploy succeeded but the source snapshot did not — call it out so the user
    // knows this version has no recoverable source and can re-run `save`.
    if (snapshotError !== null) {
      process.stdout.write(
        `\nWarning: this version was deployed WITHOUT a source snapshot (${snapshotError}).\n` +
          `Run \`save -m "..."\` to record a recoverable snapshot of the current source.\n`,
      );
    }
  } finally {
    await rm(deployPackage.tempRoot, { recursive: true, force: true });
  }
}
