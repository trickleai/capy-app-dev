import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

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
  runRollback,
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
  it("refuses without --yes and makes no network call (destructive guard)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runDelete([], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "CONFIRMATION_REQUIRED");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0, "must not hit the API without confirmation");
  });

  it("also requires --yes in --json mode (non-interactive)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runDelete([], true),
      (err: unknown) => err instanceof CliError && err.code === "CONFIRMATION_REQUIRED",
    );
    assert.equal(calls.length, 0);
  });

  it("sends DELETE and prints the result when confirmed with --yes", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", status: "deleted" }));

    const out = await capture(() => runDelete(["--yes"], false));

    assert.equal(calls[0].init?.method, "DELETE");
    assert.match(calls[0].url, /\/api\/apps\/demo-app$/);
    assert.match(out, /Deleted app "demo-app"/);
    assert.match(out, /status: deleted/);
  });

  it("emits a JSON envelope with --json --yes", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", status: "deleted" }));

    const out = await capture(() => runDelete(["--yes"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.appName, "demo-app");
    assert.equal(parsed.status, "deleted");
  });

  it("passes through a 404 APP_NOT_FOUND error from the backend", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse(
        { success: false, error: { code: "APP_NOT_FOUND", message: "App not found" } },
        404,
      ),
    );

    await assert.rejects(runDelete(["--yes"], false), (err: unknown) => {
      assert.ok(err instanceof ApiError);
      assert.equal(err.code, "APP_NOT_FOUND");
      assert.equal(err.status, 404);
      return true;
    });
  });

  it("throws MISSING_PROJECT_CONFIG when there is no .capy-app.json", async () => {
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
    stubFetch(() =>
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

    const out = await capture(() => runDeploy([], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/deploy$/);
    assert.ok(calls[0].init?.body instanceof FormData, "deploy uploads multipart FormData");
    assert.match(out, /Deployment successful/);
    assert.match(out, /Version: v7/);
    assert.match(out, /Deployed demo-app — live at/);
  });

  it("throws MISSING_DEPLOY_MANIFEST when dist/deploy.json is absent", async () => {
    await writeConfig("demo-app");
    await mkdir(path.join(workDir, "dist"), { recursive: true });
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runDeploy([], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_DEPLOY_MANIFEST",
    );
    assert.equal(calls.length, 0, "must not deploy when packaging fails");
  });

  it("throws BUILD_DIR_NOT_FOUND when the build dir is missing", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runDeploy([], false),
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

  const deployOkResponse = () =>
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

  it("uploads env vars as plain_text bindings in the `config` field", async () => {
    await writeConfigWithEnv("demo-app", { APP_TITLE: "Hello", MODE: "production" });
    await stageDist();
    stubFetch(deployOkResponse);

    await capture(() => runDeploy([], false));

    const body = calls[0].init?.body;
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

    await capture(() => runDeploy([], false));

    const body = calls[0].init?.body as FormData;
    assert.equal(body.get("config"), null, "no config field when there is no env");
  });

  it("omits the `config` field when env is present but empty", async () => {
    await writeConfigWithEnv("demo-app", {});
    await stageDist();
    stubFetch(deployOkResponse);

    await capture(() => runDeploy([], false));

    const body = calls[0].init?.body as FormData;
    assert.equal(body.get("config"), null, "no config field for an empty env object");
  });

  it("rejects a non-string env value with INVALID_PROJECT_CONFIG before deploying", async () => {
    await writeConfigWithEnv("demo-app", { COUNT: 3 });
    await stageDist();
    stubFetch(deployOkResponse);

    await assert.rejects(
      runDeploy([], false),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_PROJECT_CONFIG",
    );
    assert.equal(calls.length, 0, "must not reach the API with an invalid env");
  });

  it("rejects a non-object env (e.g. a string) with INVALID_PROJECT_CONFIG", async () => {
    await writeConfigWithEnv("demo-app", "nope");
    await stageDist();
    stubFetch(deployOkResponse);

    await assert.rejects(
      runDeploy([], false),
      (err: unknown) => err instanceof CliError && err.code === "INVALID_PROJECT_CONFIG",
    );
    assert.equal(calls.length, 0);
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
});

describe("runPublish", () => {
  it("POSTs to /publish with empty body when no deployId given and prints result", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        deployId: "abc123",
        url: "https://demo-app.example",
      }),
    );

    const out = await capture(() => runPublish([], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/publish$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {});
    assert.match(out, /Published demo-app — live at https:\/\/demo-app\.example/);
  });

  it("POSTs with {deployId} when deployId arg provided", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        deployId: "abc123",
        url: "https://demo-app.example",
      }),
    );

    await capture(() => runPublish(["abc123"], false));

    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { deployId: "abc123" });
  });

  it("emits JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        deployId: "abc123",
        url: "https://demo-app.example",
      }),
    );

    const out = await capture(() => runPublish([], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.appName, "demo-app");
    assert.equal(parsed.deployId, "abc123");
  });

  it("rejects extra positional args with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runPublish(["id1", "id2"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("throws MISSING_PROJECT_CONFIG when there is no .capy-app.json", async () => {
    stubFetch(() => jsonResponse({}));
    await assert.rejects(
      runPublish([], false),
      (err: unknown) => err instanceof CliError && err.code === "MISSING_PROJECT_CONFIG",
    );
  });
});

describe("runRollback", () => {
  it("POSTs to /rollback with {deployId} and prints result", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        deployId: "abc123",
        url: "https://demo-app.example",
      }),
    );

    const out = await capture(() => runRollback(["abc123"], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/rollback$/);
    assert.deepEqual(JSON.parse(String(calls[0].init?.body)), { deployId: "abc123" });
    assert.match(out, /Rolled back demo-app to abc123 — live at https:\/\/demo-app\.example/);
  });

  it("rejects missing deployId with INVALID_USAGE (exit 2), no network call", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runRollback([], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("rejects extra positional args with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runRollback(["id1", "id2"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });

  it("emits JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        deployId: "abc123",
        url: "https://demo-app.example",
      }),
    );

    const out = await capture(() => runRollback(["abc123"], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.deployId, "abc123");
    assert.equal(parsed.url, "https://demo-app.example");
  });
});

describe("runVersions", () => {
  it("GETs /versions and prints a table", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        versions: [
          {
            deployId: "abc123",
            version: "deploy-v1",
            workerName: "demo-app--abc123",
            status: "live",
            previewUrl: "https://demo-app--abc123.example",
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const out = await capture(() => runVersions([], false));

    assert.equal(calls[0].init?.method, "GET");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/versions$/);
    assert.match(out, /DEPLOY_ID/);
    assert.match(out, /abc123/);
    assert.match(out, /live/);
  });

  it("prints 'No versions.' for empty list", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({ success: true, appName: "demo-app", versions: [] }));

    const out = await capture(() => runVersions([], false));
    assert.match(out, /No versions\./);
  });

  it("emits JSON envelope with --json", async () => {
    await writeConfig("demo-app");
    stubFetch(() =>
      jsonResponse({
        success: true,
        appName: "demo-app",
        versions: [
          {
            deployId: "abc123",
            version: "deploy-v1",
            workerName: "demo-app--abc123",
            status: "live",
            previewUrl: "https://demo-app--abc123.example",
            createdAt: "2026-07-01T00:00:00Z",
          },
        ],
      }),
    );

    const out = await capture(() => runVersions([], true));
    const parsed = JSON.parse(out);
    assert.equal(parsed.success, true);
    assert.equal(parsed.appName, "demo-app");
    assert.equal(parsed.versions.length, 1);
    assert.equal(parsed.versions[0].deployId, "abc123");
  });

  it("rejects extra positional args with INVALID_USAGE (exit 2)", async () => {
    await writeConfig("demo-app");
    stubFetch(() => jsonResponse({}));

    await assert.rejects(runVersions(["extra"], false), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "INVALID_USAGE");
      assert.equal(err.exitCode, 2);
      return true;
    });
    assert.equal(calls.length, 0);
  });
});
