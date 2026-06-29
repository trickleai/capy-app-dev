import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  ApiError,
  apiRequest,
  CliError,
  fetchWithTimeout,
  getApiContext,
  resetSandboxIdentityCache,
  resolveSandboxIdentity,
} from "./index.ts";

/**
 * These exercise the code paths that actually talk to the platform API. We
 * replace the global `fetch` with a stub so no real network call happens, then
 * assert on the request shape and on how responses/errors are mapped.
 */

type FetchCall = { url: string; init: RequestInit | undefined };

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];

/** Install a fetch stub that returns the given response for every call. */
function stubFetch(makeResponse: (call: FetchCall) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    const call = { url, init };
    calls.push(call);
    return makeResponse(call);
  }) as typeof fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Env keys this module touches, snapshotted so we can restore them.
const ENV_KEYS = [
  "CAPY_API_URL",
  "CAPY_SECRET",
  "CAPY_AUTH_TOKEN",
  "MANAGEMENT_API_TOKEN",
  "CAPY_USER_ID",
] as const;
let envSnapshot: Record<string, string | undefined> = {};

beforeEach(() => {
  calls = [];
  resetSandboxIdentityCache();
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
});

describe("apiRequest", () => {
  const api = { baseUrl: new URL("https://api.example.test"), authToken: "tok-123" };

  it("sends bearer auth + accept headers and parses JSON", async () => {
    stubFetch(() => jsonResponse({ success: true, value: 42 }));

    const result = await apiRequest<{ success: boolean; value: number }>(api, {
      method: "GET",
      pathname: "/api/apps/demo",
    });

    assert.deepEqual(result, { success: true, value: 42 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.test/api/apps/demo");

    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("authorization"), "Bearer tok-123");
    assert.equal(headers.get("accept"), "application/json");
  });

  it("serializes the json option and sets content-type", async () => {
    stubFetch(() => jsonResponse({ success: true }));

    await apiRequest(api, { method: "POST", pathname: "/api/apps", json: { appName: "x" } });

    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get("content-type"), "application/json");
    assert.equal(calls[0].init?.body, JSON.stringify({ appName: "x" }));
  });

  it("maps a non-2xx body to ApiError carrying error.code", async () => {
    stubFetch(() => jsonResponse({ error: { code: "APP_EXISTS", message: "already taken" } }, 409));

    await assert.rejects(
      apiRequest(api, { method: "POST", pathname: "/api/apps" }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 409);
        assert.equal(err.code, "APP_EXISTS");
        assert.equal(err.message, "already taken");
        return true;
      },
    );
  });

  it("falls back to HTTP_<status> when no error.code is present", async () => {
    stubFetch(() => jsonResponse({}, 500));

    await assert.rejects(
      apiRequest(api, { method: "GET", pathname: "/api/apps/demo" }),
      (err: unknown) => err instanceof ApiError && err.code === "HTTP_500",
    );
  });

  it("rejects when a 2xx body is not valid JSON", async () => {
    stubFetch(() => new Response("<html>oops</html>", { status: 200 }));

    await assert.rejects(
      apiRequest(api, { method: "GET", pathname: "/api/apps/demo" }),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_API_RESPONSE",
    );
  });

  it("returns a legitimate null body instead of treating it as invalid (Bug 3)", async () => {
    // A 2xx response whose JSON body is literally `null` must be returned as
    // null, not misclassified as a parse failure.
    stubFetch(
      () => new Response("null", { status: 200, headers: { "content-type": "application/json" } }),
    );

    const result = await apiRequest<null>(api, { method: "GET", pathname: "/api/apps/demo" });
    assert.equal(result, null);
  });

  it("still rejects an empty (unparseable) 2xx body as INVALID_API_RESPONSE", async () => {
    stubFetch(() => new Response("", { status: 200 }));

    await assert.rejects(
      apiRequest(api, { method: "GET", pathname: "/api/apps/demo" }),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_API_RESPONSE",
    );
  });
});

describe("resolveSandboxIdentity", () => {
  const baseUrl = new URL("https://api.example.test");

  it("exchanges a secret for identity and caches it", async () => {
    stubFetch(() => jsonResponse({ valid: true, user_id: "u-1", sandbox_id: "s-1" }));

    const first = await resolveSandboxIdentity(baseUrl, "secret-abc");
    assert.deepEqual(
      { userId: first.userId, sandboxId: first.sandboxId, token: first.token },
      { userId: "u-1", sandboxId: "s-1", token: "secret-abc" },
    );
    assert.equal(calls[0].url, "https://api.example.test/internal/validate-sandbox-token");

    // Second call with same token must hit the cache, not the network.
    const second = await resolveSandboxIdentity(baseUrl, "secret-abc");
    assert.equal(second.userId, "u-1");
    assert.equal(calls.length, 1, "cached identity should not re-fetch");
  });

  it("rejects an invalid token with AUTH_INVALID", async () => {
    stubFetch(() => jsonResponse({ valid: false }));

    await assert.rejects(
      resolveSandboxIdentity(baseUrl, "bad"),
      (err: unknown) => err instanceof CliError && err.code === "AUTH_INVALID",
    );
  });

  it("rejects a 401 with AUTH_FAILED", async () => {
    stubFetch(() => jsonResponse({ error: { message: "no" } }, 401));

    await assert.rejects(
      resolveSandboxIdentity(baseUrl, "bad"),
      (err: unknown) => err instanceof CliError && err.code === "AUTH_FAILED",
    );
  });

  it("rejects incomplete identity data", async () => {
    stubFetch(() => jsonResponse({ valid: true, user_id: "u-1" }));

    await assert.rejects(
      resolveSandboxIdentity(baseUrl, "tok"),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_API_RESPONSE",
    );
  });
});

describe("getApiContext (auth resolution order)", () => {
  it("prefers CAPY_SECRET and derives userId from identity", async () => {
    process.env.CAPY_SECRET = "secret-xyz";
    stubFetch(() => jsonResponse({ valid: true, user_id: "u-9", sandbox_id: "s-9" }));

    const ctx = await getApiContext({ requireUserId: true });
    assert.equal(ctx.authToken, "secret-xyz");
    assert.equal(ctx.userId, "u-9");
    assert.equal(ctx.baseUrl.origin, "https://api.happycapy.host");
  });

  it("falls back to legacy token when no secret", async () => {
    process.env.CAPY_AUTH_TOKEN = "legacy-tok";
    const ctx = await getApiContext();
    assert.equal(ctx.authToken, "legacy-tok");
    assert.equal(calls.length, 0, "legacy path makes no network call");
  });

  it("throws MISSING_AUTH_TOKEN when nothing is configured", async () => {
    await assert.rejects(
      getApiContext(),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_AUTH_TOKEN",
    );
  });

  it("throws MISSING_USER_ID on legacy path when create requires it", async () => {
    process.env.CAPY_AUTH_TOKEN = "legacy-tok";
    await assert.rejects(
      getApiContext({ requireUserId: true }),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_USER_ID",
    );
  });

  it("respects a custom CAPY_API_URL and rejects an invalid one", async () => {
    process.env.CAPY_AUTH_TOKEN = "t";
    process.env.CAPY_API_URL = "https://custom.host";
    const ctx = await getApiContext();
    assert.equal(ctx.baseUrl.origin, "https://custom.host");

    process.env.CAPY_API_URL = "not a url";
    await assert.rejects(
      getApiContext(),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_API_URL",
    );
  });
});

describe("fetchWithTimeout (Bug 5 — network timeout)", () => {
  it("maps a fetch timeout (TimeoutError) to REQUEST_TIMEOUT", async () => {
    // When AbortSignal.timeout fires, the platform fetch rejects with a
    // TimeoutError DOMException. Simulate that directly (deterministic, no real
    // timer) and assert fetchWithTimeout maps it to a coded REQUEST_TIMEOUT.
    globalThis.fetch = (() =>
      Promise.reject(new DOMException("The operation timed out.", "TimeoutError"))) as typeof fetch;

    await assert.rejects(
      fetchWithTimeout("https://blackhole.test", {}, 50),
      (err: unknown) => err instanceof CliError && err.code === "REQUEST_TIMEOUT",
    );
  });

  it("maps a non-timeout network failure to NETWORK_ERROR", async () => {
    globalThis.fetch = (() => Promise.reject(new TypeError("fetch failed"))) as typeof fetch;

    await assert.rejects(
      fetchWithTimeout("https://broken.test", {}, 1000),
      (err: unknown) => err instanceof CliError && err.code === "NETWORK_ERROR",
    );
  });

  it("returns the response when the server replies in time", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("ok", { status: 200 }))) as typeof fetch;

    const res = await fetchWithTimeout("https://fast.test", {}, 1000);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "ok");
  });
});
