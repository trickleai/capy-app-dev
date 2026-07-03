import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext } from "../api.ts";
import { parseDirOption } from "../args.ts";
import { readProjectConfig } from "../config.ts";
import { createDeployArchive } from "../deploy-archive.ts";
import { CliError } from "../errors.ts";
import { isDeployResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { DeployConfig, DeployResponse, PlainTextBinding } from "../types.ts";

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
  const { dir } = parseDirOption(args, "deploy");
  const api = await getApiContext();
  const config = await readProjectConfig(process.cwd());
  const buildDir = path.resolve(process.cwd(), dir ?? "dist");
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
  } finally {
    await rm(deployPackage.tempRoot, { recursive: true, force: true });
  }
}
