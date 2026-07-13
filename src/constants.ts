export const CONFIG_FILE_NAME = ".capy-app.json";
/**
 * Production management API. This is the only baked-in base URL. To target a
 * non-production environment, set the CAPY_API_URL environment variable
 * explicitly — no development URL is hardcoded here.
 */
export const DEFAULT_API_URL = "https://api.happycapy.host";
export const DEFAULT_SCAFFOLD_REPO_URL = "https://github.com/trickleai/capy-scaffold-default.git";
export const RESERVED_SUBDOMAINS = new Set(["www", "api", "admin", "dashboard", "docs", "status"]);
export const APP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
export const SCAFFOLD_IGNORE_NAMES = new Set([".DS_Store", "dist", "node_modules", ".git"]);
export const LEGACY_AUTH_TOKEN_ENV_NAMES = ["CAPY_AUTH_TOKEN", "MANAGEMENT_API_TOKEN"] as const;
export const SANDBOX_SECRET_ENV_NAME = "CAPY_SECRET";
export const DEFAULT_SCAFFOLD_PATH_ENV = "CAPY_DEFAULT_SCAFFOLD_PATH";
export const DEFAULT_SCAFFOLD_REPO_ENV = "CAPY_DEFAULT_SCAFFOLD_REPO";
export const DEFAULT_SCAFFOLD_REF_ENV = "CAPY_DEFAULT_SCAFFOLD_REF";
/** Network timeout for API requests (ms). A stalled connection must not hang the CLI. */
export const API_REQUEST_TIMEOUT_MS = 30_000;
/**
 * Longer timeout (ms) for project-code store operations — the whole-workspace
 * `sync`/`commit` and blob uploads. On a cold app the server materialises the
 * source tree and can take 30s+ for the first commit; the default 30s timeout
 * would abort it and leave `deploy`'s auto-save with no snapshot. This budget
 * covers the cold path while still bounding a truly stalled connection.
 */
export const CODE_STORE_TIMEOUT_MS = 90_000;
/** Timeout for the scaffold `git clone` (ms). */
export const GIT_CLONE_TIMEOUT_MS = 60_000;
