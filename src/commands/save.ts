import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext, putBlobAt } from "../api.ts";
import { buildManifest, FALLBACK_IGNORE, makeIgnoreMatcher } from "../code-manifest.ts";
import { readProjectConfig } from "../config.ts";
import { CliError } from "../errors.ts";
import {
  isCodeIgnoreResponse,
  isCodeSyncCommitResponse,
  isCodeSyncPlanResponse,
} from "../guards.ts";
import { writeJson } from "../json.ts";
import type { CodeIgnoreResponse, CodeSyncCommitResponse, CodeSyncPlanResponse } from "../types.ts";

interface SaveOptions {
  dir?: string;
  message?: string;
}

/** Parse `save` flags: [--dir <path>] [-m|--message <msg>]. */
function parseSaveArgs(args: string[]): SaveOptions {
  const usage = () =>
    new CliError("Usage: capy-app-dev save [--dir <path>] [-m <message>] [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  const opts: SaveOptions = {};
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

export async function runSave(args: string[], json: boolean): Promise<void> {
  const opts = parseSaveArgs(args);
  const rootDir = opts.dir ? path.resolve(opts.dir) : process.cwd();

  const config = await readProjectConfig(rootDir);
  const api = await getApiContext();
  const appPath = `/api/apps/${encodeURIComponent(config.appName)}/code`;

  // Fetch the authoritative ignore list; fall back to the built-in on failure.
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
    // Older server or transient failure — proceed with the built-in list.
  }
  const isIgnored = makeIgnoreMatcher(patterns);

  // Walk the workspace and build the manifest.
  const built = await buildManifest(rootDir, isIgnored);
  // hash → { absPath, contentType } for on-demand blob upload of missing files.
  const fileMeta = new Map<string, { absPath: string; contentType: string }>();
  for (const e of built.entries) {
    if (e.kind === "file") {
      const absPath = built.hashToPath.get(e.contentHash);
      if (absPath) fileMeta.set(e.contentHash, { absPath, contentType: e.contentType });
    }
  }

  // Plan: which blobs does the server still need?
  const plan = await apiRequest<CodeSyncPlanResponse>(api, {
    method: "POST",
    pathname: `${appPath}/sync`,
    json: { manifest: built.entries },
  });
  if (!isCodeSyncPlanResponse(plan)) {
    throw new CliError("Unexpected response from code/sync", { code: "INVALID_API_RESPONSE" });
  }

  // Upload the missing blobs.
  let uploaded = 0;
  for (const hash of plan.missing) {
    const meta = fileMeta.get(hash);
    if (!meta) continue; // ignored/absent — nothing to upload
    const bytes = await readFile(meta.absPath);
    await putBlobAt(api, `${appPath}/blobs/${hash}`, bytes, meta.contentType);
    uploaded++;
  }

  // Commit: reconcile the tree to this manifest + record a snapshot.
  const commit = await apiRequest<CodeSyncCommitResponse>(api, {
    method: "POST",
    pathname: `${appPath}/sync/commit`,
    json: { manifest: built.entries, ...(opts.message ? { message: opts.message } : {}) },
  });
  if (!isCodeSyncCommitResponse(commit)) {
    throw new CliError("Unexpected response from code/sync/commit", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({
      success: true,
      appName: config.appName,
      files: built.fileCount,
      folders: built.folderCount,
      uploaded,
      ignored: plan.ignored,
      created: commit.created,
      updated: commit.updated,
      deleted: commit.deleted,
      snapshot: commit.snapshot,
    });
    return;
  }

  process.stdout.write(
    `Saved ${built.fileCount} file(s) for ${config.appName} ` +
      `(${uploaded} uploaded, ${plan.ignored} ignored).\n` +
      `  created ${commit.created}, updated ${commit.updated}, deleted ${commit.deleted}\n` +
      `  snapshot ${commit.snapshot.id}` +
      (commit.snapshot.message ? ` — ${commit.snapshot.message}` : "") +
      "\n",
  );
}
