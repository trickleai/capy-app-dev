import { execFile } from "node:child_process";
import { cp, lstat, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { SCAFFOLD_IGNORE_NAMES } from "./constants.ts";
import { CliError } from "./errors.ts";

export const execFileAsync = promisify(execFile);

export async function pathExists(targetPath: string): Promise<boolean> {
  return (await lstat(targetPath).catch(() => null)) !== null;
}

export async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function resolveInsideRoot(rootDir: string, relativePath: string, label: string): string {
  const resolvedPath = path.resolve(rootDir, relativePath);
  const normalizedRoot = `${rootDir}${path.sep}`;

  if (resolvedPath !== rootDir && !resolvedPath.startsWith(normalizedRoot)) {
    throw new CliError(`${label} must stay within ${rootDir}`, {
      code: "INVALID_DEPLOY_PATH",
    });
  }

  return resolvedPath;
}

export function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

export async function countFiles(targetPath: string): Promise<number> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats) {
    throw new CliError(`assets.directory is missing: ${targetPath}`, {
      code: "MISSING_ASSETS_DIRECTORY",
    });
  }

  if (targetStats.isFile()) {
    return 1;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }

  return total;
}

export async function countDirectoryFiles(targetPath: string, label: string): Promise<number> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats) {
    throw new CliError(`${label} is missing: ${targetPath}`, {
      code: "MISSING_DEPLOY_ARTIFACT",
    });
  }

  if (!targetStats.isDirectory()) {
    throw new CliError(`${label} must point to a directory`, {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  return countFiles(targetPath);
}

export async function listSourceEntries(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, prefix), { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (SCAFFOLD_IGNORE_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await listSourceEntries(rootDir, relativePath)));
    } else {
      paths.push(relativePath);
    }
  }

  return paths;
}

export async function copyRelativePath(
  rootDir: string,
  destinationRoot: string,
  relativePath: string,
  copied: Set<string>,
): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  if (copied.has(normalized)) {
    return;
  }

  const sourcePath = resolveInsideRoot(rootDir, relativePath, "deploy artifact");
  const sourceStats = await lstat(sourcePath).catch(() => null);
  if (!sourceStats) {
    throw new CliError(`Referenced deploy artifact is missing: ${relativePath}`, {
      code: "MISSING_DEPLOY_ARTIFACT",
    });
  }

  const destinationPath = path.join(destinationRoot, normalized);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
  copied.add(normalized);
}
