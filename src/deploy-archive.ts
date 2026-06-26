import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CliError } from "./errors.ts";
import {
  copyRelativePath,
  countDirectoryFiles,
  countFiles,
  execFileAsync,
  resolveInsideRoot,
} from "./fs-utils.ts";
import { isDeployManifest } from "./guards.ts";
import { parseJson } from "./json.ts";
import type { DeployPackageResult } from "./types.ts";

export async function createDeployArchive(buildDir: string): Promise<DeployPackageResult> {
  const buildStats = await stat(buildDir).catch(() => null);
  if (!buildStats?.isDirectory()) {
    throw new CliError(`Build directory not found: ${buildDir}`, {
      code: "BUILD_DIR_NOT_FOUND",
    });
  }

  const manifestPath = path.join(buildDir, "deploy.json");
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch {
    throw new CliError(
      `No deploy.json found in ${buildDir}\nHint: Run your build command first. The default scaffold emits deploy.json from build-server.ts; custom projects must generate dist/deploy.json with worker.entry and/or assets.directory.`,
      { code: "MISSING_DEPLOY_MANIFEST" },
    );
  }

  const parsedManifest = parseJson(rawManifest);
  const manifest = parsedManifest.ok ? parsedManifest.value : undefined;
  if (!isDeployManifest(manifest)) {
    throw new CliError("deploy.json is invalid", {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  if (!manifest.worker?.entry && !manifest.assets?.directory) {
    throw new CliError("deploy.json must define worker.entry or assets.directory", {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "capy-app-dev-"));

  // From here on the temp dir exists on disk. If any step throws, clean it up
  // before re-throwing — otherwise the orphaned dir leaks (the caller's cleanup
  // only runs for a successfully returned tempRoot). On success the temp dir is
  // intentionally kept; `runDeploy` reads the archive and removes it afterwards.
  try {
    const stageDir = path.join(tempRoot, "stage");
    const archivePath = path.join(tempRoot, "deploy.tar.gz");
    await mkdir(stageDir, { recursive: true });

    const copied = new Set<string>();
    await copyRelativePath(buildDir, stageDir, "deploy.json", copied);

    let workerEntry: string | null = null;
    if (manifest.worker?.entry) {
      workerEntry = manifest.worker.entry;
      await copyRelativePath(buildDir, stageDir, manifest.worker.entry, copied);
    }

    if (manifest.worker?.modules) {
      for (const modulePath of manifest.worker.modules) {
        await copyRelativePath(buildDir, stageDir, modulePath, copied);
      }
    }

    let assetsDirectory: string | null = null;
    let assetsCount = 0;
    if (manifest.assets?.directory) {
      assetsDirectory = manifest.assets.directory;
      assetsCount = await countFiles(
        resolveInsideRoot(buildDir, manifest.assets.directory, "assets.directory"),
      );
      await copyRelativePath(buildDir, stageDir, manifest.assets.directory, copied);
    }

    let databaseMigrationsDirectory: string | null = null;
    let databaseMigrationFiles = 0;
    if (manifest.database?.migrations) {
      databaseMigrationsDirectory = manifest.database.migrations;
      databaseMigrationFiles = await countDirectoryFiles(
        resolveInsideRoot(buildDir, manifest.database.migrations, "database.migrations"),
        "database.migrations",
      );
      await copyRelativePath(buildDir, stageDir, manifest.database.migrations, copied);
    }

    try {
      await execFileAsync("tar", ["-czf", archivePath, "-C", stageDir, "."]);
    } catch (error) {
      throw new CliError(
        error instanceof Error ? error.message : "Failed to create deploy archive",
        { code: "ARCHIVE_CREATE_FAILED" },
      );
    }

    return {
      archivePath,
      archiveName: "deploy.tar.gz",
      tempRoot,
      workerEntry,
      assetsDirectory,
      assetsCount,
      databaseMigrationsDirectory,
      databaseMigrationFiles,
    };
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
