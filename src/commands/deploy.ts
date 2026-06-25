import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext } from "../api.ts";
import { parseDirOption } from "../args.ts";
import { readProjectConfig } from "../config.ts";
import { createDeployArchive } from "../deploy-archive.ts";
import { writeJson } from "../json.ts";
import type { DeployResponse } from "../types.ts";

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

    const response = await apiRequest<DeployResponse>(api, {
      method: "POST",
      pathname: `/api/apps/${encodeURIComponent(config.appName)}/deploy`,
      body: formData,
    });

    if (json) {
      writeJson({
        success: true,
        appName: response.deployment.appName,
        url: response.deployment.url,
        version: response.deployment.version,
        assetsCount: response.deployment.assetsCount,
        deployedAt: response.deployment.deployedAt,
        database: response.deployment.database ?? null,
      });
      return;
    }

    process.stdout.write("Done\n\n");
    process.stdout.write("Deployment successful:\n");
    process.stdout.write(`  URL: ${response.deployment.url}\n`);
    process.stdout.write(`  Version: ${response.deployment.version}\n`);
    process.stdout.write(`  Assets: ${response.deployment.assetsCount} files\n`);
    if (response.deployment.database) {
      process.stdout.write(
        `  Database: ${response.deployment.database.name} (${response.deployment.database.migrationsApplied} migrations applied)\n`,
      );
    }
  } finally {
    await rm(deployPackage.tempRoot, { recursive: true, force: true });
  }
}
