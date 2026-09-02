import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { handleError } from "./help.ts";
import {
  ApiError,
  CliError,
  runCreate,
  runDelete,
  runDeploy,
  runEnv,
  runInit,
  runList,
  runPublish,
  runRestore,
  runRollback,
  runSecret,
  runSnapshots,
  runStatus,
  runVersions,
} from "./index.ts";

/**
 * Command-level (run*) integration tests. They exercise the real orchestration
 * of each command — arg handling, fs work, request shape, stdout/--json output,
 * and error/exit-code mapping — with a stubbed `fetch` (no real platform calls)
 * and a temp working directory (no side effects outside it). Deploy packaging
 * runs for real (esbuild-free: just tar over a staged dir).
 */

// ---- stdout capture ----------------------------------------------------------
// Capture stdout ONLY around the awaited callback, then restore immediately, so
// the test runner's own reporter output (also on stdout) is never intercepted.
const realStdoutWrite = process.stdout.write.bind(process.stdout);
async function capture(fn: () => Promise<void>): Promise<string> {
  let out = "";
  process.stdout.write = ((chunk: string | Uint8Array) => {
    out += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stdout.write;
  try {
    await fn();
  } finally {
    process.stdout.write = realStdoutWrite;
  }
  return out;
}

// ---- stderr capture ----------------------------------------------------------
const realStderrWrite = process.stderr.write.bind(process.stderr);
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  let err = "";
  process.stderr.write = ((chunk: string | Uint8Array) => {
    err += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
    return true;
  }) as typeof process.stderr.write;
  try {
    await fn();
  } finally {
    process.stderr.write = realStderrWrite;
  }
  return err;
}

// ---- fetch stub --------------------------------------------------------------
type FetchCall = { url: string; init: RequestInit | undefined };
const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
function stubFetch(makeResponse: (call: FetchCall) => Response): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof URL ? input.toString() : String(input);
    calls.push({ url, init });
    return makeResponse({ url, init });
  }) as typeof fetch;
}
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// Deploy now save()s the workspace source before uploading the build. saveWorkspace
// hits a small chain of code-sync endpoints first; this returns success responses
// for each so the save leg completes (yielding a snapshotId) and the deploy leg can
// proceed. Returns null for any non-code URL so the caller can supply its own
// deploy response.
function codeApiResponse(url: string): Response | null {
  if (/\/code\/ignore$/.test(url)) {
    return jsonResponse({ patterns: [] });
  }
  if (/\/code\/sync$/.test(url)) {
    return jsonResponse({ missing: [], ignored: 0 });
  }
  if (/\/code\/blobs\//.test(url)) {
    return jsonResponse({ success: true });
  }
  if (/\/code\/sync\/commit$/.test(url)) {
    return jsonResponse({
      success: true,
      created: 0,
      updated: 0,
      deleted: 0,
      snapshot: {
        id: "asnap_test",
        label: "snapshot-1",
        message: "test snapshot",
        fileCount: 0,
        sizeBytes: 0,
        createdAt: "2026-01-01T00:00:00Z",
      },
    });
  }
  return null;
}

// ---- temp cwd + env ----------------------------------------------------------
const ENV_KEYS = ["CAPY_API_URL", "CAPY_SECRET", "CAPY_AUTH_TOKEN", "CAPY_USER_ID"] as const;
let envSnapshot: Record<string, string | undefined> = {};
let originalCwd = "";
let workDir = "";

beforeEach(() => {
  calls = [];
  originalCwd = process.cwd();
  workDir = mkdtempSync(path.join(tmpdir(), "capy-cmd-"));
  process.chdir(workDir);
  envSnapshot = {};
  for (const key of ENV_KEYS) {
    envSnapshot[key] = process.env[key];
    delete process.env[key];
  }
  // Legacy-token auth path keeps these tests off the sandbox-identity fetch.
  process.env.CAPY_AUTH_TOKEN = "test-token";
  process.env.CAPY_USER_ID = "u-test";
});

afterEach(() => {
  process.stdout.write = realStdoutWrite; // safety net if a test threw mid-capture
  process.stderr.write = realStderrWrite; // safety net if a test threw mid-capture
  globalThis.fetch = realFetch;
  process.chdir(originalCwd);
  rmSync(workDir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (envSnapshot[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = envSnapshot[key];
    }
  }
});

async function writeConfig(appName: string): Promise<void> {
  await writeFile(
    path.join(workDir, ".capy-app.json"),
    JSON.stringify({ appName, url: `https://${appName}.example` }),
  );
}

describe("handleError", () => {
  it("includes ApiError details in JSON stderr and leaves detail-free errors unchanged", () => {
    const realExit = process.exit;
    let stderr = "";
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      assert.throws(
        () =>
          handleError(new ApiError(502, "D1_RESTORE_FAILED", "partial", { phase: "data" }), true),
        /exit:1/,
      );
      assert.deepEqual(JSON.parse(stderr), {
        success: false,
        error: {
          code: "D1_RESTORE_FAILED",
          message: "partial",
          details: { phase: "data" },
        },
      });

      stderr = "";
      assert.throws(
        () => handleError(new ApiError(404, "APP_NOT_FOUND", "missing"), true),
        /exit:1/,
      );
      assert.deepEqual(JSON.parse(stderr), {
        success: false,
        error: { code: "APP_NOT_FOUND", message: "missing" },
      });
    } finally {
      process.exit = realExit;
      process.stderr.write = realStderrWrite;
    }
  });
});

describe("runStatus", () => {
  it("fetches app status and prints it", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        app: {
          appName: "demo-app",
          url: "https://demo-app.example",
          createdAt: "2026-01-01",
          deployment: {
            appName: "demo-app",
            url: "https://demo-app.example",
            version: "v3",
            assetsCount: 2,
            deployedAt: "2026-02-02",
          },
          database: null,
        },
      }),
    );

    const out = await capture(() => runStatus([], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app$/);
    assert.match(out, /App: demo-app/);
    assert.match(out, /Version: v3/);
  });

  it("emits a single-line JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        app: {
          appName: "demo-app",
          url: "https://demo-app.example",
          createdAt: "2026-01-01",
          deployment: null,
          database: null,
        },
      }),
    );

    const out = await capture(() => runStatus([], true));

    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.appName, "demo-app");
  });

  it("rejects extra args with INVALID_USAGE (exit 2)", async () => {
    await assert.rejects(runStatus(["extra"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
  });

  it("throws INVALID_API_RESPONSE (not a raw TypeError) on a malformed 2xx body (Bug H1)", async () => {
    await writeConfig("demo-app");
    // A legitimate 200 whose body is missing `app` — previously this crashed with
    // `TypeError: Cannot read properties of undefined (reading 'appName')`.
    stubFetch(() => jsonResponse({ success: true }));

    await assert.rejects(runStatus([], false), (err: unknown) => {
      assert.ok(
        err instanceof CliError,
        `expected CliError, got ${(err as Error)?.constructor?.name}`,
      );
      assert.equal(err.code, "INVALID_API_RESPONSE");
      return true;
    });
  });

  it("throws MISSING_PROJECT_CONFIG when there is no .capy-app.json", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runStatus([], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_PROJECT_CONFIG",
    );
  });
});

describe("runList", () => {
  it("GETs /api/apps and prints a table for humans", async () => {
    stubFetch(() =>
      jsonResponse({
        apps: [
          {
            appName: "alpha",
            status: "active",
            workerName: "alpha",
            url: "https://alpha.example",
            createdAt: "2026-06-01T00:00:00Z",
            lastDeployedAt: "2026-06-05T00:00:00Z",
            lastVersion: "v3",
          },
          {
            appName: "beta",
            status: "active",
            workerName: "beta",
            url: "https://beta.example",
            createdAt: "2026-06-10T00:00:00Z",
            lastDeployedAt: null,
            lastVersion: null,
          },
        ],
      }),
    );

    const out = await capture(() => runList([], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps$/, "must hit /api/apps with no query by default");
    assert.doesNotMatch(calls[0].url, /all=/, "must NOT send all=1 without --all");
    assert.match(out, /NAME/);
    assert.match(out, /alpha/);
    assert.match(out, /beta/);
  });

  it("sends ?all=1 when --all is passed", async () => {
    stubFetch(() => jsonResponse({ apps: [] }));

    await capture(() => runList(["--all"], false));

    assert.match(calls[0].url, /\/api\/apps\?all=1$/);
  });

  it("also accepts the short -a alias", async () => {
    stubFetch(() => jsonResponse({ apps: [] }));

    await capture(() => runList(["-a"], false));

    assert.match(calls[0].url, /\/api\/apps\?all=1$/);
  });

  it("emits a JSON envelope with --json", async () => {
    stubFetch(() =>
      jsonResponse({
        apps: [
          {
            appName: "alpha",
            status: "active",
            workerName: "alpha",
            url: "https://alpha.example",
            createdAt: "2026-06-01T00:00:00Z",
          },
        ],
      }),
    );

    const out = await capture(() => runList([], true));

    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.apps.length, 1);
    assert.equal(parsed.apps[0].appName, "alpha");
  });

  it("handles an empty list cleanly", async () => {
    stubFetch(() => jsonResponse({ apps: [] }));

    const out = await capture(() => runList([], false));
    assert.match(out, /No active apps/);
  });

  it("rejects extra positional args with INVALID_USAGE (exit 2)", async () => {
    stubFetch(() => jsonResponse({ apps: [] }));

    await assert.rejects(runList(["extra"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("throws INVALID_API_RESPONSE on a malformed 2xx body", async () => {
    stubFetch(() => jsonResponse({ apps: [{ appName: "no-status" }] }));

    await assert.rejects(runList([], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_API_RESPONSE");
      return true;
    });
  });

  it("passes backend errors through (e.g. 401 unauthorized)", async () => {
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } },
        401,
      ),
    );

    await assert.rejects(runList([], false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "UNAUTHORIZED");
      assert.equal(err.status, 401);
      return true;
    });
  });
});

describe("runDelete", () => {
  it("refuses cwd-based deletion without --yes before authentication or network", async () => {
    await writeConfig("demo-app");
    delete process.env.CAPY_AUTH_TOKEN;
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runDelete([], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CONFIRMATION_REQUIRED");
      assert.equal(err.exitCode, 2);
      assert.match(err.message, /"demo-app"/);
      return true;
    });
    assert.equal(calls.length, 0, "must not hit the API without confirmation");
  });

  it("refuses named soft- and hard-delete without --yes before auth or network", async () => {
    delete process.env.CAPY_AUTH_TOKEN;
    stubFetch(() => jsonResponse({}));

    for (const args of [["named-app"], ["named-app", "--hard"]]) {
      await assert.rejects(runDelete(args, true), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "CONFIRMATION_REQUIRED");
        assert.equal(err.exitCode, 2);
        assert.match(err.message, /"named-app"/);
        if (args.includes("--hard")) {
          assert.match(err.message, /--hard --yes/);
        }
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });

  it("keeps cwd-based soft-delete behavior and prints the local-config note", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", status: "deleted" }));

    const out = await capture(() => runDelete(["--yes"], false));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/demo-app$/);
    assert.equal(calls[0].init?.body, undefined);
    assert.match(out, /Deleted app "demo-app"/);
    assert.match(out, /status: deleted/);
    assert.match(out, /\.capy-app\.json still references this app/);
  });

  it("soft-deletes an explicit name from a directory without project config", async () => {
    stubFetch(() => jsonResponse({ success: true, appName: "named-app", status: "deleted" }));

    const out = await capture(() => runDelete(["named-app", "--yes"], false));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/named-app$/);
    assert.equal(calls[0].init?.body, undefined);
    assert.match(out, /Deleted app "named-app"/);
    assert.doesNotMatch(out, /\.capy-app\.json/);
  });

  it("trims an explicit name and ignores malformed cwd config", async () => {
    await writeFile(path.join(workDir, ".capy-app.json"), "not-json");
    stubFetch(() => jsonResponse({ success: true, appName: "named-app", status: "deleted" }));

    await capture(() => runDelete(["  named-app  ", "-y"], false));

    assert.match(calls[0].url, /\/api\/apps\/named-app$/);
  });

  it("hard-deletes an explicit name with the existing request body", async () => {
    stubFetch(() => jsonResponse({ success: true, appName: "named-app", status: "deleted" }));

    const out = await capture(() => runDelete(["--hard", "named-app", "--yes"], false));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/named-app$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { hard: true });
    assert.match(out, /Hard-deleted app "named-app"/);
    assert.doesNotMatch(out, /\.capy-app\.json/);
  });

  it("emits the existing JSON envelope for an explicit name", async () => {
    stubFetch(() => jsonResponse({ success: true, appName: "named-app", status: "deleted" }));

    const out = await capture(() => runDelete(["named-app", "--yes"], true));
    assert.deepEqual(JSON.parse(out), {
      success: true,
      appName: "named-app",
      status: "deleted",
    });
  });

  it("rejects invalid explicit names before authentication or network access", async () => {
    delete process.env.CAPY_AUTH_TOKEN;
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runDelete(["  Invalid Name  ", "--yes"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_APP_NAME");
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects unknown flags and extra positional names as INVALID_USAGE", async () => {
    stubFetch(() => jsonResponse({}));

    for (const args of [
      ["named-app", "--force"],
      ["first-app", "second-app", "--yes"],
    ]) {
      await assert.rejects(runDelete(args, false), (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });

  it("passes through backend errors for explicit names", async () => {
    for (const backendError of [
      { status: 404, code: "APP_NOT_FOUND", message: "App not found" },
      { status: 403, code: "FORBIDDEN", message: "Not your app" },
    ]) {
      stubFetch(() =>
        jsonResponse(
          {
            success: false,
            error: { code: backendError.code, message: backendError.message },
          },
          backendError.status,
        ),
      );

      await assert.rejects(runDelete(["named-app", "--yes"], false), (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.code, backendError.code);
        assert.equal(err.status, backendError.status);
        return true;
      });
    }
  });

  it("throws MISSING_PROJECT_CONFIG for cwd-based deletion without config", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runDelete(["--yes"], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_PROJECT_CONFIG",
    );
    assert.equal(calls.length, 0);
  });
});

describe("runCreate", () => {
  it("creates the app, writes .capy-app.json, and prints the URL", async () => {
    stubFetch(() =>
      jsonResponse({
        success: true,
        app: { appName: "new-app", url: "https://new-app.example", createdAt: "2026-03-03" },
      }),
    );

    const out = await capture(() => runCreate(["new-app"], false));

    // POST to /api/apps with the app name in the body.
    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps$/);
    assert.match(String(calls[0].init?.body), /new-app/);

    // Config file persisted.
    const config = JSON.parse(await readFile(path.join(workDir, ".capy-app.json"), "utf8"));
    assert.equal(config.appName, "new-app");
    assert.match(out, /Creating app "new-app"/);
  });

  it("refuses to overwrite an existing .capy-app.json", async () => {
    await writeConfig("existing");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runCreate(["another"], false),
      (err: unknown) => err instanceof CliError && err.code === "CONFIG_ALREADY_EXISTS",
    );
    assert.equal(calls.length, 0, "must not hit the API when config already exists");
  });

  it("rejects an invalid app name before any network call", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runCreate(["Invalid_Name"], false),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_APP_NAME",
    );
    assert.equal(calls.length, 0);
  });

  // Quota: the backend returns 402 APP_QUOTA_EXCEEDED when the account is at its
  // plan's app limit. The CLI must surface code + message intact (so the agent
  // can prompt an upgrade) and must NOT persist a config file for an app that
  // was never created.
  it("surfaces a 402 APP_QUOTA_EXCEEDED create error with code + message intact", async () => {
    const quotaMessage = "App limit reached for your plan (3). Upgrade to create more apps.";
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "APP_QUOTA_EXCEEDED", message: quotaMessage } },
        402,
      ),
    );

    await assert.rejects(runCreate(["over-limit"], false), (err: unknown) => {
      assert.ok(err instanceof ApiError, `expected ApiError, got ${(err as Error)?.name}`);
      assert.equal(err.code, "APP_QUOTA_EXCEEDED");
      assert.equal(err.status, 402);
      assert.equal(err.message, quotaMessage, "human-readable upgrade message must be preserved");
      assert.notEqual(err.exitCode, 0, "must exit non-zero");
      return true;
    });

    // No config written for an app that was rejected.
    await assert.rejects(readFile(path.join(workDir, ".capy-app.json"), "utf8"));
  });

  it("preserves the quota error code + message on the --json path too", async () => {
    const quotaMessage = "App limit reached for your plan (3). Upgrade to create more apps.";
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "APP_QUOTA_EXCEEDED", message: quotaMessage } },
        402,
      ),
    );

    await assert.rejects(runCreate(["over-limit"], true), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "APP_QUOTA_EXCEEDED");
      assert.equal(err.message, quotaMessage);
      return true;
    });
  });
});

describe("runDeploy", () => {
  // Build a minimal valid dist/ that createDeployArchive will package for real.
  async function stageDist(): Promise<void> {
    const dist = path.join(workDir, "dist");
    await mkdir(path.join(dist, "server"), { recursive: true });
    await mkdir(path.join(dist, "client"), { recursive: true });
    await writeFile(path.join(dist, "server", "index.js"), "export default {};");
    await writeFile(path.join(dist, "client", "index.html"), "<!doctype html>");
    await writeFile(
      path.join(dist, "deploy.json"),
      JSON.stringify({ worker: { entry: "server/index.js" }, assets: { directory: "client" } }),
    );
  }

  it("rejects an empty --dir with INVALID_USAGE instead of targeting cwd (Bug M1)", async () => {
    // parseDirOption runs before any fs/network work, so no config/stub needed.
    await assert.rejects(runDeploy(["--dir="], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0, "must not reach the API with an empty --dir");
  });

  it("packages dist and deploys, printing the result", async () => {
    await writeConfig("demo-app");
    await stageDist();
    stubFetch(
      (call) =>
        codeApiResponse(call.url) ??
        jsonResponse({
          success: true,
          deployment: {
            appName: "demo-app",
            url: "https://demo-app.example",
            version: "v7",
            assetsCount: 1,
            deployedAt: "2026-04-04",
          },
          previewUrl: "https://demo-app--abc123.example",
          deployId: "abc123",
          published: true,
        }),
    );

    const out = await capture(() => runDeploy(["-m", "ship v7"], false));

    const deployCall = calls.find((c) => /\/deploy$/.test(c.url));
    assert.ok(deployCall, "expected a POST to the /deploy endpoint");
    assert.equal(deployCall.init?.method, "POST");
    assert.match(deployCall.url, /\/api\/apps\/demo-app\/deploy$/);
    assert.ok(deployCall.init?.body instanceof FormData, "deploy uploads multipart FormData");
    // The deploy carries the source snapshot id produced by the save leg.
    assert.equal((deployCall.init?.body as FormData).get("snapshotId"), "asnap_test");
    assert.match(out, /Deployment successful/);
    assert.match(out, /Version: v7/);
    assert.match(out, /Deployed demo-app — live at/);
  });

  it("still deploys but reports snapshotSaved:false + snapshotError when the save leg fails", async () => {
    await writeConfig("demo-app");
    await stageDist();
    // Fail the source-save leg (code/sync 500) so saveWorkspace throws; the deploy
    // itself must still succeed (best-effort), but the outcome must be explicit.
    stubFetch((call) => {
      if (/\/code\//.test(call.url)) {
        return jsonResponse({ error: { code: "REPO_ERROR", message: "boom" } }, 500);
      }
      return jsonResponse({
        success: true,
        deployment: {
          appName: "demo-app",
          url: "https://demo-app.example",
          version: "v9",
          assetsCount: 1,
          deployedAt: "2026-04-04",
        },
        previewUrl: "https://demo-app--x.example",
        deployId: "x",
        published: false,
      });
    });

    const out = await capture(() => runDeploy(["-m", "ship despite save fail"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true, "deploy still succeeds");
    assert.equal(parsed.snapshotId, null);
    assert.equal(parsed.snapshotSaved, false);
    assert.equal(typeof parsed.snapshotError, "string", "carries a non-null error detail");

    // No snapshotId is sent to the deploy endpoint when the save was skipped.
    const deployCall = calls.find((c) => /\/deploy$/.test(c.url));
    assert.ok(deployCall, "deploy still reaches the API");
    assert.equal((deployCall.init?.body as FormData).get("snapshotId"), null);
  });

  it("prints an explicit warning (text mode) when the source snapshot is skipped", async () => {
    await writeConfig("demo-app");
    await stageDist();
    stubFetch((call) => {
      if (/\/code\//.test(call.url)) {
        return jsonResponse({ error: { code: "REPO_ERROR", message: "boom" } }, 500);
      }
      return jsonResponse({
        success: true,
        deployment: {
          appName: "demo-app",
          url: "https://demo-app.example",
          version: "v9",
          assetsCount: 1,
          deployedAt: "2026-04-04",
        },
        previewUrl: "https://demo-app--x.example",
        deployId: "x",
        published: false,
      });
    });

    const out = await capture(() => runDeploy(["-m", "ship despite save fail"], false));
    assert.match(out, /Deployment successful/);
    assert.match(out, /WITHOUT a source snapshot/);
    assert.match(out, /Run `save -m/);
  });

  it("throws MISSING_DEPLOY_MANIFEST when dist/deploy.json is absent", async () => {
    await writeConfig("demo-app");
    await mkdir(path.join(workDir, "dist"), { recursive: true });
    // Let the (best-effort) save leg succeed; packaging must still fail hard.
    stubFetch((call) => codeApiResponse(call.url) ?? jsonResponse({}));
    await assert.rejects(
      runDeploy(["-m", "attempt"], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_DEPLOY_MANIFEST",
    );
    // Packaging fails before the deploy POST — no /deploy request is made.
    assert.equal(
      calls.filter((c) => /\/deploy$/.test(c.url)).length,
      0,
      "must not deploy when packaging fails",
    );
  });

  it("throws BUILD_DIR_NOT_FOUND when the build dir is missing", async () => {
    await writeConfig("demo-app");
    stubFetch((call) => codeApiResponse(call.url) ?? jsonResponse({}));
    await assert.rejects(
      runDeploy(["-m", "attempt"], false),
      (err: unknown) => err instanceof CliError && err.code === "BUILD_DIR_NOT_FOUND",
    );
  });

  // ---- env vars upload (feat/deploy-env-vars) -------------------------------
  // Write a .capy-app.json carrying an arbitrary `env` block.
  async function writeConfigWithEnv(appName: string, env: unknown): Promise<void> {
    await writeFile(
      path.join(workDir, ".capy-app.json"),
      JSON.stringify({ appName, url: `https://${appName}.example`, env }),
    );
  }

  // Dispatches the save-leg code endpoints to success, then answers the /deploy
  // POST with a canned deploy response.
  const deployOkResponse = (call: FetchCall) =>
    codeApiResponse(call.url) ??
    jsonResponse({
      success: true,
      deployment: {
        appName: "demo-app",
        url: "https://demo-app.example",
        version: "v9",
        assetsCount: 1,
        deployedAt: "2026-05-05",
      },
      previewUrl: "https://demo-app--xyz.example",
      deployId: "xyz",
      published: false,
    });

  // Locate the deploy POST among the calls (it is the last request, after the
  // save-leg code endpoints).
  const findDeployCall = (): FetchCall => {
    const deployCall = calls.find((c) => /\/deploy$/.test(c.url));
    assert.ok(deployCall, "expected a POST to the /deploy endpoint");
    return deployCall;
  };

  it("uploads env vars as plain_text bindings in the `config` field", async () => {
    await writeConfigWithEnv("demo-app", { APP_TITLE: "Hello", MODE: "production" });
    await stageDist();
    stubFetch(deployOkResponse);

    await capture(() => runDeploy(["-m", "with env"], false));

    const body = findDeployCall().init?.body;
    assert.ok(body instanceof FormData, "deploy uploads multipart FormData");
    const configField = body.get("config");
    assert.equal(typeof configField, "string", "config must be a serialized string field");
    assert.deepEqual(JSON.parse(configField as string), {
      bindings: [
        { type: "plain_text", name: "APP_TITLE", text: "Hello" },
        { type: "plain_text", name: "MODE", text: "production" },
      ],
    });
    // The legacy standalone `env` field must not be sent (backend ignores it).
    assert.equal(body.get("env"), null, "must not send a standalone env field");
  });

  it("omits the `config` field entirely when the project config has no env", async () => {
    await writeConfig("demo-app");
    await stageDist();
    stubFetch(deployOkResponse);

    await capture(() => runDeploy(["-m", "no env"], false));

    const body = findDeployCall().init?.body as FormData;
    assert.equal(body.get("config"), null, "no config field when there is no env");
  });

  it("omits the `config` field when env is present but empty", async () => {
    await writeConfigWithEnv("demo-app", {});
    await stageDist();
    stubFetch(deployOkResponse);

    await capture(() => runDeploy(["-m", "empty env"], false));

    const body = findDeployCall().init?.body as FormData;
    assert.equal(body.get("config"), null, "no config field for an empty env object");
  });

  it("rejects a non-string env value with INVALID_PROJECT_CONFIG before deploying", async () => {
    await writeConfigWithEnv("demo-app", { COUNT: 3 });
    await stageDist();
    stubFetch(deployOkResponse);

    await assert.rejects(
      runDeploy(["-m", "bad env"], false),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_PROJECT_CONFIG",
    );
    assert.equal(calls.length, 0, "must not reach the API with an invalid env");
  });

  it("rejects a non-object env (e.g. a string) with INVALID_PROJECT_CONFIG", async () => {
    await writeConfigWithEnv("demo-app", "nope");
    await stageDist();
    stubFetch(deployOkResponse);

    await assert.rejects(
      runDeploy(["-m", "bad env"], false),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_PROJECT_CONFIG",
    );
    assert.equal(calls.length, 0);
  });

  it("rejects a missing -m message with MISSING_MESSAGE (exit 2) before any network call", async () => {
    await writeConfig("demo-app");
    await stageDist();
    stubFetch((call) => codeApiResponse(call.url) ?? jsonResponse({}));

    await assert.rejects(runDeploy([], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "MISSING_MESSAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0, "must not hit the API without a message");
  });
});

describe("runInit", () => {
  // Point CAPY_DEFAULT_SCAFFOLD_PATH at a local scaffold dir so init copies from
  // disk (highest-priority source) — no clone, no network.
  let scaffoldDir = "";

  async function stageScaffold(): Promise<void> {
    scaffoldDir = mkdtempSync(path.join(tmpdir(), "capy-scaffold-"));
    await writeFile(path.join(scaffoldDir, "package.json"), '{"name":"scaffold"}\n');
    await mkdir(path.join(scaffoldDir, "src"), { recursive: true });
    await writeFile(path.join(scaffoldDir, "src", "index.ts"), "// scaffold entry\n");
    process.env.CAPY_DEFAULT_SCAFFOLD_PATH = scaffoldDir;
  }

  afterEach(() => {
    delete process.env.CAPY_DEFAULT_SCAFFOLD_PATH;
    if (scaffoldDir) {
      rmSync(scaffoldDir, { recursive: true, force: true });
      scaffoldDir = "";
    }
  });

  it("copies the scaffold into the working directory", async () => {
    await stageScaffold();

    const out = await capture(() => runInit([], false));

    assert.equal(
      await readFile(path.join(workDir, "package.json"), "utf8"),
      '{"name":"scaffold"}\n',
    );
    assert.equal(
      await readFile(path.join(workDir, "src", "index.ts"), "utf8"),
      "// scaffold entry\n",
    );
    assert.match(out, /Initializing scaffold/);
  });

  it("refuses to overwrite existing files (INIT_CONFLICT)", async () => {
    await stageScaffold();
    await writeFile(path.join(workDir, "package.json"), '{"name":"mine"}\n');

    await assert.rejects(
      runInit([], false),
      (err: unknown) => err instanceof CliError && err.code === "INIT_CONFLICT",
    );
    // The user's file must be left untouched.
    assert.equal(await readFile(path.join(workDir, "package.json"), "utf8"), '{"name":"mine"}\n');
  });

  it("throws SCAFFOLD_NOT_FOUND when the configured path is missing", async () => {
    process.env.CAPY_DEFAULT_SCAFFOLD_PATH = path.join(tmpdir(), "definitely-does-not-exist-xyz");
    await assert.rejects(
      runInit([], false),
      (err: unknown) => err instanceof CliError && err.code === "SCAFFOLD_NOT_FOUND",
    );
  });

  // Regression for the scaffold clone temp-dir leak (audit M2). Uses a real
  // local `file://` clone so the resolved scaffold owns a cleanup() that removes
  // a `capy-scaffold-default-*` temp dir. After init, no such temp dir must
  // remain — the fix moved listSourceEntries inside the try so its finally
  // (cleanup) always runs.
  it("cleans up the cloned scaffold temp dir after init (Bug M2)", async () => {
    const TMP = tmpdir();
    const before = new Set(readdirSync(TMP).filter((n) => n.startsWith("capy-scaffold-default-")));

    // Build a local git repo to clone from (no network).
    const repo = mkdtempSync(path.join(TMP, "m2-srcrepo-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@t.co"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "t"], { cwd: repo });
      writeFileSync(path.join(repo, "package.json"), '{"name":"scaffold"}\n');
      execFileSync("git", ["add", "-A"], { cwd: repo });
      execFileSync("git", ["commit", "-qm", "init"], { cwd: repo });

      delete process.env.CAPY_DEFAULT_SCAFFOLD_PATH; // force the clone path
      process.env.CAPY_DEFAULT_SCAFFOLD_REPO = `file://${repo}`;

      await capture(() => runInit([], false));

      const after = readdirSync(TMP).filter(
        (n) => n.startsWith("capy-scaffold-default-") && !before.has(n),
      );
      assert.equal(after.length, 0, `clone temp dir leaked: ${after.join(", ")}`);
    } finally {
      delete process.env.CAPY_DEFAULT_SCAFFOLD_REPO;
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(workDir, ".capy-app.json"), "utf8"));
}

describe("runEnv", () => {
  it("rejects an unknown subcommand with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(runEnv(["bogus"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("env list GETs the env endpoint and prints a NAME/VALUE table", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", env: { APP_TITLE: "Hi", MODE: "prod" } }),
    );

    const out = await capture(() => runEnv(["list"], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env$/);
    assert.match(out, /APP_TITLE\s+Hi/);
    assert.match(out, /MODE\s+prod/);
  });

  it("env list emits a JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", env: { A: "1" } }));

    const out = await capture(() => runEnv(["list"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.env, { A: "1" });
  });

  it("env list prints a friendly message when there are no vars", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", env: {} }));

    const out = await capture(() => runEnv(["list"], false));
    assert.match(out, /No env vars\./);
  });

  it("env set PUTs {value} and mirrors the var into .capy-app.json", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE" }));

    const out = await capture(() => runEnv(["set", "APP_TITLE", "Hello World"], false));

    assert.equal(calls[0].init?.method, "PUT");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env\/APP_TITLE$/);
    assert.equal(JSON.parse(String(calls[0].init?.body)).value, "Hello World");
    assert.match(out, /Set env "APP_TITLE"/);
    const cfg = await readConfig();
    assert.deepEqual(cfg.env, { APP_TITLE: "Hello World" });
  });

  it("env set requires both NAME and VALUE (INVALID_USAGE, no network)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(runEnv(["set", "ONLYNAME"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("env unset DELETEs and removes the key from .capy-app.json", async () => {
    await writeFile(
      path.join(workDir, ".capy-app.json"),
      JSON.stringify({
        appName: "demo-app",
        url: "https://demo-app.example",
        env: { APP_TITLE: "Hi", MODE: "prod" },
      }),
    );
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE", deleted: true }),
    );

    const out = await capture(() => runEnv(["unset", "APP_TITLE"], true));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env\/APP_TITLE$/);
    const parsed = JSON.parse(out);
    assert.equal(parsed.deleted, true);
    const cfg = await readConfig();
    assert.deepEqual(cfg.env, { MODE: "prod" });
  });

  it("env unset drops the env field entirely when it becomes empty", async () => {
    await writeFile(
      path.join(workDir, ".capy-app.json"),
      JSON.stringify({
        appName: "demo-app",
        url: "https://demo-app.example",
        env: { APP_TITLE: "Hi" },
      }),
    );
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE", deleted: true }),
    );

    await capture(() => runEnv(["unset", "APP_TITLE"], false));
    const cfg = await readConfig();
    assert.equal("env" in cfg, false, "empty env should be omitted, not left as {}");
  });

  it("passes through a 404 APP_NOT_FOUND from the backend", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "APP_NOT_FOUND", message: "App not found" } },
        404,
      ),
    );
    await assert.rejects(runEnv(["list"], false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "APP_NOT_FOUND");
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("throws MISSING_PROJECT_CONFIG when there is no .capy-app.json", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runEnv(["list"], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_PROJECT_CONFIG",
    );
  });

  it("prints a deprecation warning to stderr when called", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", env: { A: "1" } }));

    const err = await captureStderr(() => capture(() => runEnv(["list"], false)).then(() => {}));
    assert.match(
      err,
      /Warning: 'capy-app-dev env' is deprecated; use 'capy-app-dev secret' instead\./,
    );
  });
});

describe("runSecret", () => {
  it("rejects an unknown subcommand with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(runSecret(["bogus"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("secret list GETs the env endpoint and prints a NAME/VALUE table", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", env: { APP_TITLE: "Hi", MODE: "prod" } }),
    );

    const out = await capture(() => runSecret(["list"], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env$/);
    assert.match(out, /APP_TITLE\s+Hi/);
    assert.match(out, /MODE\s+prod/);
  });

  it("secret list emits a JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", env: { A: "1" } }));

    const out = await capture(() => runSecret(["list"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.deepEqual(parsed.env, { A: "1" });
  });

  it("secret list prints a friendly message when there are no vars", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", env: {} }));

    const out = await capture(() => runSecret(["list"], false));
    assert.match(out, /No env vars\./);
  });

  it("secret set PUTs {value} and mirrors the var into .capy-app.json", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE" }));

    const out = await capture(() => runSecret(["set", "APP_TITLE", "Hello World"], false));

    assert.equal(calls[0].init?.method, "PUT");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env\/APP_TITLE$/);
    assert.equal(JSON.parse(String(calls[0].init?.body)).value, "Hello World");
    assert.match(out, /Set env "APP_TITLE"/);
    const cfg = await readConfig();
    assert.deepEqual(cfg.env, { APP_TITLE: "Hello World" });
  });

  it("secret set requires both NAME and VALUE (INVALID_USAGE, no network)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(runSecret(["set", "ONLYNAME"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("secret unset DELETEs and removes the key from .capy-app.json", async () => {
    await writeFile(
      path.join(workDir, ".capy-app.json"),
      JSON.stringify({
        appName: "demo-app",
        url: "https://demo-app.example",
        env: { APP_TITLE: "Hi", MODE: "prod" },
      }),
    );
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE", deleted: true }),
    );

    const out = await capture(() => runSecret(["unset", "APP_TITLE"], true));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/env\/APP_TITLE$/);
    const parsed = JSON.parse(out);
    assert.equal(parsed.deleted, true);
    const cfg = await readConfig();
    assert.deepEqual(cfg.env, { MODE: "prod" });
  });

  it("secret unset drops the env field entirely when it becomes empty", async () => {
    await writeFile(
      path.join(workDir, ".capy-app.json"),
      JSON.stringify({
        appName: "demo-app",
        url: "https://demo-app.example",
        env: { APP_TITLE: "Hi" },
      }),
    );
    stubFetch(() =>
      jsonResponse({ success: true, appName: "demo-app", name: "APP_TITLE", deleted: true }),
    );

    await capture(() => runSecret(["unset", "APP_TITLE"], false));
    const cfg = await readConfig();
    assert.equal("env" in cfg, false, "empty env should be omitted, not left as {}");
  });

  it("passes through a 404 APP_NOT_FOUND from the backend", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "APP_NOT_FOUND", message: "App not found" } },
        404,
      ),
    );
    await assert.rejects(runSecret(["list"], false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "APP_NOT_FOUND");
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("throws MISSING_PROJECT_CONFIG when there is no .capy-app.json", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runSecret(["list"], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_PROJECT_CONFIG",
    );
  });
});

describe("runPublish", () => {
  const ordinarySuccess = {
    success: true,
    appName: "demo-app",
    deployId: "abc123",
    url: "https://demo-app.example",
    withData: false,
    codePublished: true,
    dataRestored: false,
  };

  it("POSTs an empty body for ordinary latest-preview publish", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(ordinarySuccess));

    const out = await capture(() => runPublish([], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/publish$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
    assert.match(out, /Published demo-app — live at https:\/\/demo-app\.example/);
    assert.doesNotMatch(out, /D1 data restored/);
  });

  it("POSTs {deployId} for ordinary explicit publish", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(ordinarySuccess));

    await capture(() => runPublish(["abc123"], false));

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { deployId: "abc123" });
  });

  it("publishes with data only with explicit ID and confirmation", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        ...ordinarySuccess,
        withData: true,
        dataRestored: true,
      }),
    );

    const out = await capture(() => runPublish(["abc123", "--with-data", "--yes"], false));

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
      deployId: "abc123",
      withData: true,
    });
    assert.match(out, /Published demo-app — live at https:\/\/demo-app\.example/);
    assert.match(out, /D1 data restored to the target deployment bookmark\./);
  });

  it("emits all observed outcome fields for ordinary publish in JSON mode", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(ordinarySuccess));

    const out = await capture(() => runPublish([], true));
    assert.deepEqual(JSON.parse(out), ordinarySuccess);
  });

  it("emits all observed outcome fields for confirmed with-data publish in JSON mode", async () => {
    await writeConfig("demo-app");
    const withDataSuccess = {
      ...ordinarySuccess,
      withData: true,
      dataRestored: true,
    };
    stubFetch(() => jsonResponse(withDataSuccess));

    const out = await capture(() => runPublish(["abc123", "--with-data", "--yes"], true));

    assert.deepEqual(JSON.parse(out), withDataSuccess);
  });

  it("rejects invalid argument combinations before config, auth, or network access", async () => {
    stubFetch(() => jsonResponse({}));
    const cases: Array<{ args: string[]; code: string }> = [
      { args: ["--with-data"], code: "INVALID_USAGE" },
      { args: ["--with-data", "--yes"], code: "INVALID_USAGE" },
      { args: ["abc123", "--with-data"], code: "CONFIRMATION_REQUIRED" },
      { args: ["abc123", "--yes"], code: "INVALID_USAGE" },
      { args: ["abc123", "--unknown"], code: "INVALID_USAGE" },
      { args: ["abc123", "--with-data", "--with-data", "--yes"], code: "INVALID_USAGE" },
      { args: ["abc123", "--with-data", "--yes", "--yes"], code: "INVALID_USAGE" },
      { args: ["id1", "id2"], code: "INVALID_USAGE" },
      { args: ["   "], code: "INVALID_USAGE" },
    ];

    for (const testCase of cases) {
      await assert.rejects(runPublish(testCase.args, false), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, testCase.code, testCase.args.join(" "));
        assert.equal(error.exitCode, 2);
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });

  it("preserves machine-readable backend partial-failure details", async () => {
    await writeConfig("demo-app");
    const details = {
      appName: "demo-app",
      deployId: "abc123",
      url: "https://demo-app.example",
      withData: true,
      codePublished: true,
      dataRestored: false,
      reason: "upstream_rejected",
    };
    stubFetch(() =>
      jsonResponse(
        {
          success: false,
          error: {
            code: "D1_RESTORE_FAILED",
            message: "Code was published, but D1 restore did not complete. Verify D1 state.",
            details,
          },
        },
        502,
      ),
    );

    await assert.rejects(
      runPublish(["abc123", "--with-data", "--yes"], false),
      (error: unknown) => {
        assert.ok(error instanceof ApiError);
        assert.equal(error.code, "D1_RESTORE_FAILED");
        assert.deepEqual(error.details, details);
        return true;
      },
    );
  });

  it("prints only the backend error for a human-mode restore partial failure", async () => {
    await writeConfig("demo-app");
    const message =
      "Code was published, but D1 restore did not complete. Verify D1 state before retrying.";
    stubFetch(() =>
      jsonResponse(
        {
          success: false,
          error: {
            code: "D1_RESTORE_FAILED",
            message,
            details: {
              appName: "demo-app",
              deployId: "abc123",
              url: "https://demo-app.example",
              withData: true,
              codePublished: true,
              dataRestored: false,
              reason: "upstream_rejected",
            },
          },
        },
        502,
      ),
    );

    const realExit = process.exit;
    let stdout = "";
    let stderr = "";
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as typeof process.exit;

    try {
      await assert.rejects(async () => {
        try {
          await runPublish(["abc123", "--with-data", "--yes"], false);
        } catch (error) {
          handleError(error, false);
        }
      }, /exit:1/);
    } finally {
      process.exit = realExit;
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
    }

    assert.equal(stdout, "");
    assert.equal(stderr, `Error: ${message}\n`);
    assert.doesNotMatch(`${stdout}${stderr}`, /Published|D1 data restored/);
  });

  it("rejects a malformed success payload", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ ...ordinarySuccess, codePublished: false }));

    await assert.rejects(
      runPublish([], false),
      (error: unknown) => error instanceof CliError && error.code === "INVALID_API_RESPONSE",
    );
  });
});

describe("runRollback", () => {
  const rollbackSuccess = {
    success: true,
    appName: "demo-app",
    deployId: "abc123",
    url: "https://demo-app--preview.example",
  };

  it("POSTs only {deployId} and describes preview-only effects", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(rollbackSuccess));

    const out = await capture(() => runRollback(["abc123"], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/rollback$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { deployId: "abc123" });
    assert.match(out, /Staged demo-app deployment abc123 at preview/);
    assert.match(out, /Live site and D1 data are unchanged\./);
    assert.doesNotMatch(out, /live at/);
  });

  it("emits a JSON response without legacy data fields", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(rollbackSuccess));

    const out = await capture(() => runRollback(["abc123"], true));
    assert.deepEqual(JSON.parse(out), rollbackSuccess);
  });

  it("rejects missing, blank, extra, flag, and legacy-option args before local I/O", async () => {
    stubFetch(() => jsonResponse({}));
    const cases = [
      [],
      ["   "],
      ["id1", "id2"],
      ["--unknown"],
      ["abc123", "--with-data"],
      ["abc123", "--yes"],
      ["abc123", "--with-data", "--yes"],
    ];

    for (const args of cases) {
      await assert.rejects(runRollback(args, false), (error: unknown) => {
        assert.ok(error instanceof CliError);
        assert.equal(error.code, "INVALID_USAGE", args.join(" "));
        assert.equal(error.exitCode, 2);
        return true;
      });
    }
    assert.equal(calls.length, 0);
  });
});

describe("runVersions", () => {
  const versionsSuccess = {
    success: true,
    appName: "demo-app",
    versions: [
      {
        deployId: "live-id",
        version: "deploy-v2",
        workerName: "historical-worker-name",
        status: "live",
        url: "https://demo-app.example",
        createdAt: "2026-07-02T00:00:00Z",
        snapshotId: "asnap_live",
      },
      {
        deployId: "old-id",
        version: "deploy-v1",
        workerName: "historical-worker-name",
        status: "superseded",
        url: null,
        createdAt: "2026-07-01T00:00:00Z",
        snapshotId: null,
      },
    ],
  };

  it("GETs /versions and safely renders reachable and null URLs", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(versionsSuccess));

    const out = await capture(() => runVersions([], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/versions$/);
    assert.match(out, /DEPLOY_ID\s+STATUS\s+VERSION\s+URL\s+CREATED_AT/);
    assert.match(out, /https:\/\/demo-app\.example/);
    assert.match(out, /old-id\s+superseded\s+deploy-v1\s+-/);
    assert.doesNotMatch(out, /PREVIEW_URL/);
  });

  it("prints 'No versions.' for empty list", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", versions: [] }));

    const out = await capture(() => runVersions([], false));
    assert.match(out, /No versions\./);
  });

  it("preserves nullable URLs in JSON mode", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse(versionsSuccess));

    const out = await capture(() => runVersions([], true));
    assert.deepEqual(JSON.parse(out), versionsSuccess);
  });

  it("rejects a legacy previewUrl-only payload", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        versions: [
          {
            ...versionsSuccess.versions[0],
            url: undefined,
            previewUrl: "https://demo-app--old-id.example",
          },
        ],
      }),
    );

    await assert.rejects(
      runVersions([], false),
      (error: unknown) => error instanceof CliError && error.code === "INVALID_API_RESPONSE",
    );
  });

  it("rejects extra positional args before network access", async () => {
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runVersions(["extra"], false), (error: unknown) => {
      assert.ok(error instanceof CliError);
      assert.equal(error.code, "INVALID_USAGE");
      assert.equal(error.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("runSnapshots", () => {
  it("GETs /code/snapshots and prints a table", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        snapshots: [
          {
            id: "asnap_2",
            label: "",
            message: "second change",
            fileCount: 12,
            sizeBytes: 3400,
            createdAt: "2026-07-02T00:00:00Z",
          },
          {
            id: "asnap_1",
            label: "",
            message: "first change",
            fileCount: 10,
            sizeBytes: 3000,
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const out = await capture(() => runSnapshots([], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/code\/snapshots$/);
    assert.match(out, /SNAPSHOT_ID/);
    assert.match(out, /asnap_2/);
    assert.match(out, /second change/);
  });

  it("prints a hint for an empty list", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ snapshots: [] }));

    const out = await capture(() => runSnapshots([], false));
    assert.match(out, /No snapshots/);
  });

  it("emits JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        snapshots: [
          {
            id: "asnap_1",
            label: "",
            message: "only change",
            fileCount: 5,
            sizeBytes: 100,
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const out = await capture(() => runSnapshots([], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.appName, "demo-app");
    assert.equal(parsed.snapshots.length, 1);
    assert.equal(parsed.snapshots[0].id, "asnap_1");
  });

  it("rejects extra positional args with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runSnapshots(["extra"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});

describe("runRestore", () => {
  // Serve the restore leg: POST restore, GET ignore, recursive file listing, and
  // file content bytes. The snapshot tree here is: /keep.txt ("A1") + /sub/c.txt ("C1").
  function restoreStub(): (call: FetchCall) => Response {
    return (call) => {
      const { url, init } = call;
      if (/\/code\/snapshots\/[^/]+\/restore$/.test(url) && init?.method === "POST") {
        return jsonResponse({ ok: true, restored: 2, deleted: 1 });
      }
      if (/\/code\/ignore$/.test(url)) {
        return jsonResponse({ patterns: [] });
      }
      if (/\/code\/files\?dir=/.test(url)) {
        const dir = decodeURIComponent(url.split("dir=")[1] ?? "/");
        if (dir === "/") {
          return jsonResponse({
            dir: "/",
            entries: [
              {
                id: "f_keep",
                kind: "file",
                name: "keep.txt",
                path: "/keep.txt",
                dir: "/",
                contentHash: "h1",
                sizeBytes: 2,
                contentType: "text/plain",
                updatedAt: "t",
              },
              {
                id: "d_sub",
                kind: "folder",
                name: "sub",
                path: "/sub",
                dir: "/",
                contentHash: null,
                sizeBytes: null,
                contentType: null,
                updatedAt: "t",
              },
            ],
          });
        }
        return jsonResponse({
          dir: "/sub",
          entries: [
            {
              id: "f_c",
              kind: "file",
              name: "c.txt",
              path: "/sub/c.txt",
              dir: "/sub",
              contentHash: "h2",
              sizeBytes: 2,
              contentType: "text/plain",
              updatedAt: "t",
            },
          ],
        });
      }
      if (/\/code\/files\/f_keep\/content$/.test(url)) {
        return new Response("A1", { status: 200 });
      }
      if (/\/code\/files\/f_c\/content$/.test(url)) {
        return new Response("C1", { status: 200 });
      }
      return jsonResponse({}, 404);
    };
  }

  it("requires --yes: CONFIRMATION_REQUIRED (exit 2) with no network call", async () => {
    await writeConfig("demo-app");
    stubFetch(restoreStub());

    await assert.rejects(runRestore(["asnap_1"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CONFIRMATION_REQUIRED");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0, "must not hit the API without --yes");
  });

  it("rejects a missing snapshotId with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(restoreStub());

    await assert.rejects(runRestore(["--yes"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("restores: writes snapshot files locally and deletes local files not in the snapshot", async () => {
    await writeConfig("demo-app");
    // Local workspace before restore: keep.txt (stale), extra.txt (added since snapshot).
    await writeFile(path.join(workDir, "keep.txt"), "STALE");
    await writeFile(path.join(workDir, "extra.txt"), "ADDED");
    stubFetch(restoreStub());

    const out = await capture(() => runRestore(["asnap_1", "--yes"], false));

    // Server restore was invoked.
    assert.ok(calls.some((c) => /\/code\/snapshots\/asnap_1\/restore$/.test(c.url)));
    // keep.txt overwritten to snapshot content; sub/c.txt created.
    assert.equal(await readFile(path.join(workDir, "keep.txt"), "utf8"), "A1");
    assert.equal(await readFile(path.join(workDir, "sub", "c.txt"), "utf8"), "C1");
    // extra.txt deleted (absent from snapshot).
    await assert.rejects(readFile(path.join(workDir, "extra.txt"), "utf8"));
    assert.match(out, /Restored demo-app to snapshot asnap_1/);
  });

  it("propagates SNAPSHOT_NOT_FOUND (404) for an unknown snapshot from the backend", async () => {
    await writeConfig("demo-app");
    // The restore endpoint reports an unknown snapshot id as SNAPSHOT_NOT_FOUND
    // (404) — the same code deploy-app uses for its snapshotId check.
    stubFetch((call) => {
      if (/\/restore$/.test(call.url)) {
        return jsonResponse(
          { error: { code: "SNAPSHOT_NOT_FOUND", message: "Snapshot not found." } },
          404,
        );
      }
      return jsonResponse({}, 404);
    });

    await assert.rejects(runRestore(["asnap_missing", "--yes"], false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.status, 404);
      assert.equal(err.code, "SNAPSHOT_NOT_FOUND");
      return true;
    });
  });

  it("emits JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    await writeFile(path.join(workDir, "extra.txt"), "ADDED");
    stubFetch(restoreStub());

    const out = await capture(() => runRestore(["asnap_1", "--yes"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.snapshotId, "asnap_1");
    assert.equal(parsed.written, 2);
    assert.equal(parsed.deletedLocally, 1);
  });
});
