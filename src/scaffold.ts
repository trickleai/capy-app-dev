import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_SCAFFOLD_PATH_ENV,
  DEFAULT_SCAFFOLD_REF_ENV,
  DEFAULT_SCAFFOLD_REPO_ENV,
  DEFAULT_SCAFFOLD_REPO_URL,
  GIT_CLONE_TIMEOUT_MS,
} from "./constants.ts";
import { CliError } from "./errors.ts";
import { execFileAsync, pathExists } from "./fs-utils.ts";
import type { ScaffoldSource } from "./types.ts";

function getBundledScaffoldRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
  return path.resolve(packageRoot, "..", "scaffolds", "default-app");
}

export async function resolveDefaultScaffoldSource(): Promise<ScaffoldSource> {
  const configuredPath = process.env[DEFAULT_SCAFFOLD_PATH_ENV]?.trim();
  if (configuredPath) {
    const root = path.resolve(configuredPath);
    if (!(await pathExists(root))) {
      throw new CliError(`${DEFAULT_SCAFFOLD_PATH_ENV} points to a missing directory: ${root}`, {
        code: "SCAFFOLD_NOT_FOUND",
      });
    }

    return {
      root,
      label: root,
    };
  }

  const bundledRoot = getBundledScaffoldRoot();
  if (await pathExists(bundledRoot)) {
    return {
      root: bundledRoot,
      label: bundledRoot,
    };
  }

  return downloadDefaultScaffoldRepo();
}

export async function downloadDefaultScaffoldRepo(): Promise<ScaffoldSource> {
  const repoUrl = process.env[DEFAULT_SCAFFOLD_REPO_ENV]?.trim() || DEFAULT_SCAFFOLD_REPO_URL;
  const repoRef = process.env[DEFAULT_SCAFFOLD_REF_ENV]?.trim();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "capy-scaffold-default-"));
  const checkoutDir = path.join(tempRoot, "repo");
  const gitArgs = ["clone", "--depth", "1"];

  if (repoRef) {
    gitArgs.push("--branch", repoRef);
  }

  gitArgs.push(repoUrl, checkoutDir);

  try {
    await execFileAsync("git", gitArgs, { signal: AbortSignal.timeout(GIT_CLONE_TIMEOUT_MS) });
  } catch {
    await rm(tempRoot, { recursive: true, force: true });
    throw new CliError(
      `Failed to fetch default scaffold from ${repoUrl}. Configure ${DEFAULT_SCAFFOLD_PATH_ENV} for a local scaffold checkout if needed.`,
      { code: "SCAFFOLD_FETCH_FAILED" },
    );
  }

  return {
    root: checkoutDir,
    label: repoUrl,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}
