import {
  API_REQUEST_TIMEOUT_MS,
  DEFAULT_API_URL,
  LEGACY_AUTH_TOKEN_ENV_NAMES,
  SANDBOX_SECRET_ENV_NAME,
} from "./constants.ts";
import { getFirstConfiguredEnvValue } from "./env.ts";
import { ApiError, CliError } from "./errors.ts";
import { isRecord, isSandboxIdentityResponse } from "./guards.ts";
import { parseJson, readApiErrorMessage } from "./json.ts";
import type { SandboxIdentity } from "./types.ts";

let cachedSandboxIdentity: SandboxIdentity | null = null;

/** Test-only: clear the memoized sandbox identity so cases don't leak state. */
export function resetSandboxIdentityCache(): void {
  cachedSandboxIdentity = null;
}

export async function getApiContext(options?: { requireUserId?: boolean }): Promise<{
  baseUrl: URL;
  authToken: string;
  userId?: string;
}> {
  const rawApiUrl = process.env.CAPY_API_URL?.trim() || DEFAULT_API_URL;

  let baseUrl: URL;
  try {
    baseUrl = new URL(rawApiUrl);
  } catch {
    throw new CliError(`Invalid CAPY_API_URL: ${rawApiUrl}`, {
      code: "INVALID_API_URL",
    });
  }

  const sandboxSecret = process.env[SANDBOX_SECRET_ENV_NAME]?.trim();
  if (sandboxSecret) {
    const identity = await resolveSandboxIdentity(baseUrl, sandboxSecret);
    return {
      baseUrl,
      authToken: identity.token,
      userId: identity.userId,
    };
  }

  const authToken = getFirstConfiguredEnvValue(LEGACY_AUTH_TOKEN_ENV_NAMES);
  if (!authToken) {
    throw new CliError(
      `One of these environment variables is required: ${SANDBOX_SECRET_ENV_NAME}, ${LEGACY_AUTH_TOKEN_ENV_NAMES.join(", ")}`,
      {
        code: "MISSING_AUTH_TOKEN",
      },
    );
  }

  const userId = process.env.CAPY_USER_ID?.trim();
  if (options?.requireUserId && !userId) {
    throw new CliError("CAPY_USER_ID is required for create", {
      code: "MISSING_USER_ID",
    });
  }

  return {
    baseUrl,
    authToken,
    userId,
  };
}

/**
 * `fetch` with a hard timeout. Without this a stalled connection (server accepts
 * the socket but never responds) hangs the process forever, which hangs the agent
 * that invoked the CLI. On timeout the request is aborted and a coded CliError is
 * thrown instead of leaking a raw AbortError.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new CliError(`Request timed out after ${timeoutMs}ms`, {
        code: "REQUEST_TIMEOUT",
      });
    }
    throw new CliError(error instanceof Error ? error.message : "Network request failed", {
      code: "NETWORK_ERROR",
    });
  }
}

export async function resolveSandboxIdentity(
  baseUrl: URL,
  token: string,
): Promise<SandboxIdentity> {
  if (cachedSandboxIdentity?.token === token) {
    return cachedSandboxIdentity;
  }

  const response = await fetchWithTimeout(
    new URL("/internal/validate-sandbox-token", baseUrl),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ token }),
    },
    API_REQUEST_TIMEOUT_MS,
  );

  const rawText = await response.text();
  const parsed = parseJson(rawText);
  const payload = parsed.ok ? parsed.value : undefined;

  if (!response.ok) {
    const message = readApiErrorMessage(payload, response.status);
    throw new CliError(message, {
      code: response.status === 401 ? "AUTH_FAILED" : "VALIDATION_REQUEST_FAILED",
    });
  }

  if (!isSandboxIdentityResponse(payload)) {
    throw new CliError("Sandbox token validation returned an invalid response", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (!payload.valid) {
    throw new CliError("Sandbox token is invalid", {
      code: "AUTH_INVALID",
    });
  }

  if (!payload.user_id || !payload.sandbox_id) {
    throw new CliError("Sandbox token validation returned incomplete identity data", {
      code: "INVALID_API_RESPONSE",
    });
  }

  cachedSandboxIdentity = {
    userId: payload.user_id,
    sandboxId: payload.sandbox_id,
    issuedAt: payload.issued_at,
    token,
  };

  return cachedSandboxIdentity;
}

export async function apiRequest<T>(
  api: { baseUrl: URL; authToken: string },
  options: {
    method: string;
    pathname: string;
    json?: unknown;
    body?: BodyInit;
  },
): Promise<T> {
  const url = new URL(options.pathname, api.baseUrl);
  const headers = new Headers({
    Authorization: `Bearer ${api.authToken}`,
    Accept: "application/json",
  });

  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }

  const response = await fetchWithTimeout(
    url,
    {
      method: options.method,
      headers,
      body,
    },
    API_REQUEST_TIMEOUT_MS,
  );

  const rawText = await response.text();
  const parsed = parseJson(rawText);
  const payload = parsed.ok ? parsed.value : undefined;

  if (!response.ok) {
    const errorCode =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
        ? payload.error.code
        : `HTTP_${response.status}`;
    const errorMessage = readApiErrorMessage(payload, response.status);
    throw new ApiError(response.status, errorCode, errorMessage);
  }

  // Distinguish a JSON parse failure from a legitimately parsed `null` body:
  // only the former is an invalid response.
  if (!parsed.ok) {
    throw new CliError(`API returned invalid JSON for ${url.pathname}`, {
      code: "INVALID_API_RESPONSE",
    });
  }

  return parsed.value as T;
}

/**
 * Upload a content-addressed blob (raw bytes body, not JSON) to an explicit
 * pathname. Used by the project-code `save` flow to stream file content the
 * server is missing. Returns the parsed `{ contentHash, sizeBytes, deduped }`.
 */
export async function putBlobAt(
  api: { baseUrl: URL; authToken: string },
  pathname: string,
  bytes: Uint8Array,
  contentType: string,
): Promise<{ contentHash: string; sizeBytes: number; deduped: boolean }> {
  const url = new URL(pathname, api.baseUrl);
  const ct = contentType || "application/octet-stream";
  const response = await fetchWithTimeout(
    url,
    {
      method: "PUT",
      headers: new Headers({
        Authorization: `Bearer ${api.authToken}`,
        Accept: "application/json",
        "content-type": ct,
      }),
      // Wrap in a Blob: a Uint8Array isn't a `BodyInit` under this lib config,
      // and a Buffer's ArrayBufferLike backing isn't a `BlobPart` — copy into a
      // plain ArrayBuffer-backed view.
      body: new Blob([new Uint8Array(bytes)], { type: ct }),
    },
    API_REQUEST_TIMEOUT_MS,
  );

  const rawText = await response.text();
  const parsed = parseJson(rawText);
  const payload = parsed.ok ? parsed.value : undefined;
  if (!response.ok) {
    const code =
      isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
        ? payload.error.code
        : `HTTP_${response.status}`;
    throw new ApiError(response.status, code, readApiErrorMessage(payload, response.status));
  }
  if (!isRecord(payload) || typeof payload.contentHash !== "string") {
    throw new CliError(`Blob upload returned an invalid response for ${pathname}`, {
      code: "INVALID_API_RESPONSE",
    });
  }
  return {
    contentHash: payload.contentHash,
    sizeBytes: typeof payload.sizeBytes === "number" ? payload.sizeBytes : bytes.length,
    deduped: payload.deduped === true,
  };
}
