import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext, getBytesAt } from "../api.ts";
import { FALLBACK_IGNORE, makeIgnoreMatcher } from "../code-manifest.ts";
import { readProjectConfig } from "../config.ts";
import { CONFIG_FILE_NAME } from "../constants.ts";
import { CliError } from "../errors.ts";
import { isCodeFilesResponse, isCodeIgnoreResponse, isCodeRestoreResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { CodeFileEntry, CodeIgnoreResponse } from "../types.ts";

interface RestoreOptions {
  snapshotId?: string;
  dir?: string;
  yes?: boolean;
}

/** Parse `restore` flags: <snapshotId> [--yes] [--dir <path>]. */
function parseRestoreArgs(args: string[]): RestoreOptions {
  const usage = () =>
    new CliError("Usage: capy-app-dev restore <snapshotId> [--yes] [--dir <path>] [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  const opts: RestoreOptions = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--yes" || a === "-y") {
      opts.yes = true;
    } else if (a === "--dir" || a === "-d") {
      opts.dir = args[++i];
      if (opts.dir === undefined) throw usage();
    } else if (a.startsWith("--dir=")) {
      opts.dir = a.slice("--dir=".length);
    } else if (!a.startsWith("-") && opts.snapshotId === undefined) {
      opts.snapshotId = a;
    } else {
      throw usage();
    }
  }
  if (opts.snapshotId === undefined || opts.snapshotId.trim() === "") throw usage();
  if (opts.dir !== undefined && opts.dir.trim() === "") throw usage();
  return opts;
}

/** Recursively collect every file entry in the live tree, dir by dir. */
async function collectLiveFiles(
  api: Awaited<ReturnType<typeof getApiContext>>,
  appPath: string,
): Promise<CodeFileEntry[]> {
  const files: CodeFileEntry[] = [];
  const dirs = ["/"];
  while (dirs.length > 0) {
    const dir = dirs.pop() as string;
    const res = await apiRequest<unknown>(api, {
      method: "GET",
      pathname: `${appPath}/files?dir=${encodeURIComponent(dir)}`,
    });
    if (!isCodeFilesResponse(res)) {
      throw new CliError("Unexpected response from code/files", { code: "INVALID_API_RESPONSE" });
    }
    for (const e of res.entries) {
      if (e.kind === "folder") {
        dirs.push(e.path);
      } else {
        files.push(e);
      }
    }
  }
  return files;
}

/**
 * Walk the local `rootDir` and return the set of relative file paths (POSIX,
 * leading-slash form like `/src/index.js`), skipping ignored paths so we never
 * touch node_modules/.git/etc. Used to find local files absent from the
 * snapshot so restore can delete them (true revert).
 */
async function collectLocalFiles(
  rootDir: string,
  isIgnored: (p: string) => boolean,
): Promise<Set<string>> {
  const found = new Set<string>();
  async function walk(absDir: string, rel: string): Promise<void> {
    const dirents = await readdir(absDir, { withFileTypes: true }).catch(() => []);
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const absPath = `/${childRel}`;
      if (isIgnored(absPath)) continue;
      const childAbs = path.join(absDir, d.name);
      if (d.isDirectory()) {
        await walk(childAbs, childRel);
      } else if (d.isFile()) {
        found.add(absPath);
      }
    }
  }
  await walk(rootDir, "");
  return found;
}

export async function runRestore(args: string[], json: boolean): Promise<void> {
  const opts = parseRestoreArgs(args);
  const snapshotId = opts.snapshotId as string;
  const rootDir = opts.dir ? path.resolve(opts.dir) : process.cwd();

  // Restore is destructive: it overwrites local files with the snapshot's
  // content AND deletes local files that the snapshot doesn't have. Require an
  // explicit --yes so an agent never wipes uncommitted work by accident.
  if (!opts.yes) {
    throw new CliError(
      "restore overwrites your local workspace to match the snapshot — files added " +
        "since the snapshot are DELETED, and changed files are overwritten. Re-run with " +
        '--yes to confirm. (Tip: `save -m "..."` your current work first if you want to keep it.)',
      { code: "CONFIRMATION_REQUIRED", exitCode: 2 },
    );
  }

  const config = await readProjectConfig(rootDir);
  const api = await getApiContext();
  const appPath = `/api/apps/${encodeURIComponent(config.appName)}/code`;

  // 1. Revert the server-side live tree to the snapshot (true revert). An
  //    unknown snapshot surfaces as 404 SNAPSHOT_NOT_FOUND from the backend.
  const restoreRes = await apiRequest<unknown>(api, {
    method: "POST",
    pathname: `${appPath}/snapshots/${encodeURIComponent(snapshotId)}/restore`,
  });
  if (!isCodeRestoreResponse(restoreRes)) {
    throw new CliError("Unexpected response from restore API", { code: "INVALID_API_RESPONSE" });
  }

  // 2. Fetch the authoritative ignore list (so local deletion never touches
  //    node_modules/.git/etc); fall back to the built-in on failure.
  let patterns = FALLBACK_IGNORE;
  try {
    const res = await apiRequest<CodeIgnoreResponse>(api, {
      method: "GET",
      pathname: `${appPath}/ignore`,
    });
    if (isCodeIgnoreResponse(res)) {
      patterns = [...new Set([...res.patterns, ...FALLBACK_IGNORE])];
    }
  } catch {
    // proceed with the built-in list
  }
  const isIgnored = makeIgnoreMatcher(patterns);

  // 3. Download the (now reverted) live tree and write it over the workspace.
  const liveFiles = await collectLiveFiles(api, appPath);
  const snapshotPaths = new Set<string>();
  let written = 0;
  for (const f of liveFiles) {
    snapshotPaths.add(f.path);
    const bytes = await getBytesAt(api, `${appPath}/files/${encodeURIComponent(f.id)}/content`);
    const absTarget = path.join(rootDir, f.path.replace(/^\//, ""));
    await mkdir(path.dirname(absTarget), { recursive: true });
    await writeFile(absTarget, bytes);
    written++;
  }

  // 4. Delete local files absent from the snapshot (true revert), skipping
  //    ignored paths so dependencies/VCS survive.
  const localFiles = await collectLocalFiles(rootDir, isIgnored);
  let deleted = 0;
  for (const localPath of localFiles) {
    // Never delete the CLI project config: it's workspace identity (app name +
    // url), not source, and the snapshot never contains it. Removing it would
    // orphan the workspace from its app.
    if (localPath === `/${CONFIG_FILE_NAME}`) continue;
    if (!snapshotPaths.has(localPath)) {
      await rm(path.join(rootDir, localPath.replace(/^\//, "")), { force: true });
      deleted++;
    }
  }

  if (json) {
    writeJson({
      success: true,
      appName: config.appName,
      snapshotId,
      written,
      deletedLocally: deleted,
      serverRestored: restoreRes.restored,
      serverDeleted: restoreRes.deleted,
    });
    return;
  }

  process.stdout.write(
    `Restored ${config.appName} to snapshot ${snapshotId}.\n` +
      `  wrote ${written} file(s) locally, deleted ${deleted} local file(s) not in the snapshot\n` +
      `  (server tree: restored ${restoreRes.restored}, deleted ${restoreRes.deleted})\n` +
      'Local code now matches the snapshot. Run `deploy -m "..."` to ship this version.\n',
  );
}
