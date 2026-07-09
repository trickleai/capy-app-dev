import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import type { CodeManifestEntry } from "./types.ts";

/**
 * Built-in fallback ignore list, used only when the server's `GET /code/ignore`
 * is unreachable. The server list is authoritative; this mirrors its intent
 * (dependency/install dirs + VCS + caches + OS junk — NOT build outputs).
 */
export const FALLBACK_IGNORE: string[] = [
  "node_modules/",
  ".git/",
  ".hg/",
  ".svn/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "vendor/",
  "target/",
  ".gradle/",
  "Pods/",
  ".bundle/",
  ".dart_tool/",
  ".pub-cache/",
  ".cargo/",
  ".pnpm-store/",
  "bower_components/",
  ".cache/",
  ".next/",
  ".nuxt/",
  ".svelte-kit/",
  ".turbo/",
  ".parcel-cache/",
  "*.log",
  "*.pyc",
  ".DS_Store",
  "Thumbs.db",
];

/**
 * Build an ignore matcher from gitignore-ish patterns. Implements the same
 * subset the server enforces so client and server agree:
 *   - a pattern ending `/` or a bare dir name  → match if ANY path segment == name
 *   - `*.ext`                                   → match if the basename ends with `.ext`
 *   - a plain filename                          → match if the basename == it
 * `path` is absolute-style (`/src/index.js`).
 */
export function makeIgnoreMatcher(patterns: string[]): (path: string) => boolean {
  const dirNames = new Set<string>();
  const extSuffixes: string[] = [];
  const fileNames = new Set<string>();

  for (const raw of patterns) {
    const p = raw.trim();
    if (!p) continue;
    if (p.endsWith("/")) {
      dirNames.add(p.slice(0, -1));
    } else if (p.startsWith("*.")) {
      extSuffixes.push(p.slice(1)); // ".ext"
    } else if (!p.includes("/") && !p.includes("*")) {
      // A bare token: treat as both a dir name and an exact filename.
      dirNames.add(p);
      fileNames.add(p);
    } else {
      fileNames.add(p);
    }
  }

  return (absPath: string): boolean => {
    const segments = absPath.split("/").filter(Boolean);
    if (segments.some((s) => dirNames.has(s))) return true;
    const base = segments[segments.length - 1] ?? "";
    if (fileNames.has(base)) return true;
    if (extSuffixes.some((ext) => base.endsWith(ext))) return true;
    return false;
  };
}

const CONTENT_TYPES: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".jsx": "text/javascript",
  ".ts": "text/typescript",
  ".tsx": "text/typescript",
  ".json": "application/json",
  ".css": "text/css",
  ".html": "text/html",
  ".htm": "text/html",
  ".md": "text/markdown",
  ".txt": "text/plain",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".toml": "text/plain",
  ".yaml": "text/plain",
  ".yml": "text/plain",
};

/** Guess a content-type from a file's extension (default octet-stream). */
export function contentTypeFor(name: string): string {
  return CONTENT_TYPES[path.extname(name).toLowerCase()] ?? "application/octet-stream";
}

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export interface BuiltManifest {
  entries: CodeManifestEntry[];
  /** contentHash → absolute filesystem path (for on-demand blob upload). */
  hashToPath: Map<string, string>;
  fileCount: number;
  folderCount: number;
}

/**
 * Walk `rootDir` and build a project-code manifest. Applies `isIgnored`
 * (absolute-style path) to skip ignored directories/files entirely. Folders
 * (including empty ones) are emitted as explicit `folder` entries so the tree
 * round-trips exactly. Symlinks are skipped (a deploy artifact is never a link).
 */
export async function buildManifest(
  rootDir: string,
  isIgnored: (path: string) => boolean,
): Promise<BuiltManifest> {
  const entries: CodeManifestEntry[] = [];
  const hashToPath = new Map<string, string>();
  let fileCount = 0;
  let folderCount = 0;

  async function walk(absDir: string, rel: string): Promise<void> {
    const dirents = await readdir(absDir, { withFileTypes: true });
    for (const d of dirents) {
      if (d.isSymbolicLink()) continue;
      const childRel = rel ? `${rel}/${d.name}` : d.name;
      const absPath = `/${childRel}`;
      if (isIgnored(absPath)) continue;
      const childAbs = path.join(absDir, d.name);
      if (d.isDirectory()) {
        entries.push({ kind: "folder", path: absPath });
        folderCount++;
        await walk(childAbs, childRel);
      } else if (d.isFile()) {
        const bytes = await readFile(childAbs);
        const hash = sha256Hex(bytes);
        entries.push({
          kind: "file",
          path: absPath,
          contentHash: hash,
          sizeBytes: bytes.length,
          contentType: contentTypeFor(d.name),
        });
        hashToPath.set(hash, childAbs);
        fileCount++;
      }
    }
  }

  await walk(rootDir, "");
  return { entries, hashToPath, fileCount, folderCount };
}
