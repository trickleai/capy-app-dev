import { readFile } from "node:fs/promises";
import path from "node:path";

import { apiRequest, getApiContext, putBlobAt } from "../api.ts";
import { buildManifest, FALLBACK_IGNORE, makeIgnoreMatcher } from "../code-manifest.ts";
import { readProjectConfig } from "../config.ts";
import { CODE_STORE_TIMEOUT_MS } from "../constants.ts";
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

/** Result of a workspace save — the recorded snapshot plus sync counts. */
export interface SaveResult {
  snapshotId: string;
  fileCount: number;
  folderCount: number;
  uploaded: number;
  ignored: number;
  created: number;
  updated: number;
  deleted: number;
  message: string | null;
}

/**
 * Validate that a snapshot/deploy message is present and non-empty. The message
 * is mandatory because it is the only human-readable handle for finding and
 * rolling back to a version later. Returns the trimmed message or throws.
 */
export function requireMessage(message: string | undefined): string {
  const trimmed = (message ?? "").trim();
  if (trimmed === "") {
    throw new CliError(
      'A snapshot message is required. Pass -m "<what changed and why>" ' +
        '(e.g. -m "add dark-mode toggle"). Empty messages make versions unfindable later.',
      { code: "MISSING_MESSAGE", exitCode: 2 },
    );
  }
  return trimmed;
}

/**
 * Core save flow, reusable by both `save` and `deploy`: fetch the ignore list,
 * walk `rootDir`, plan + upload missing blobs, commit a snapshot with `message`.
 * `message` must be a non-empty string (validated by callers).
 */
export async function saveWorkspace(
  api: Awaited<ReturnType<typeof getApiContext>>,
  appName: string,
  rootDir: string,
  message: string,
): Promise<SaveResult> {
  const appPath = `/api/apps/${encodeURIComponent(appName)}/code`;

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

  const built = await buildManifest(rootDir, isIgnored);
  const fileMeta = new Map<string, { absPath: string; contentType: string }>();
  for (const e of built.entries) {
    if (e.kind === "file") {
      const absPath = built.hashToPath.get(e.contentHash);
      if (absPath) fileMeta.set(e.contentHash, { absPath, contentType: e.contentType });
    }
  }

  const plan = await apiRequest<CodeSyncPlanResponse>(api, {
    method: "POST",
    pathname: `${appPath}/sync`,
    json: { manifest: built.entries },
    timeoutMs: CODE_STORE_TIMEOUT_MS,
  });
  if (!isCodeSyncPlanResponse(plan)) {
    throw new CliError("Unexpected response from code/sync", { code: "INVALID_API_RESPONSE" });
  }

  let uploaded = 0;
  for (const hash of plan.missing) {
    const meta = fileMeta.get(hash);
    if (!meta) continue;
    const bytes = await readFile(meta.absPath);
    await putBlobAt(
      api,
      `${appPath}/blobs/${hash}`,
      bytes,
      meta.contentType,
      CODE_STORE_TIMEOUT_MS,
    );
    uploaded++;
  }

  const commit = await apiRequest<CodeSyncCommitResponse>(api, {
    method: "POST",
    pathname: `${appPath}/sync/commit`,
    json: { manifest: built.entries, message },
    timeoutMs: CODE_STORE_TIMEOUT_MS,
  });
  if (!isCodeSyncCommitResponse(commit)) {
    throw new CliError("Unexpected response from code/sync/commit", {
      code: "INVALID_API_RESPONSE",
    });
  }

  return {
    snapshotId: commit.snapshot.id,
    fileCount: built.fileCount,
    folderCount: built.folderCount,
    uploaded,
    ignored: plan.ignored,
    created: commit.created,
    updated: commit.updated,
    deleted: commit.deleted,
    message: commit.snapshot.message,
  };
}

/** Parse `save` flags: [--dir <path>] [-m|--message <msg>]. */
function parseSaveArgs(args: string[]): SaveOptions {
  const usage = () =>
    new CliError("Usage: capy-app-dev save -m <message> [--dir <path>] [--json]", {
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

  // A snapshot message is mandatory: it is the only human-readable way to find
  // and roll back to a version later. Reject empty/whitespace before any work.
  const message = requireMessage(opts.message);

  const config = await readProjectConfig(rootDir);
  const api = await getApiContext();

  const r = await saveWorkspace(api, config.appName, rootDir, message);

  if (json) {
    writeJson({
      success: true,
      appName: config.appName,
      files: r.fileCount,
      folders: r.folderCount,
      uploaded: r.uploaded,
      ignored: r.ignored,
      created: r.created,
      updated: r.updated,
      deleted: r.deleted,
      snapshot: { id: r.snapshotId, message: r.message },
    });
    return;
  }

  process.stdout.write(
    `Saved ${r.fileCount} file(s) for ${config.appName} ` +
      `(${r.uploaded} uploaded, ${r.ignored} ignored).\n` +
      `  created ${r.created}, updated ${r.updated}, deleted ${r.deleted}\n` +
      `  snapshot ${r.snapshotId}${r.message ? ` — ${r.message}` : ""}\n`,
  );
}
