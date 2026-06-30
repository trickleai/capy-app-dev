import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { ApiError, CliError, runCreate, runDeploy, runInit, runStatus } from "./index.ts";

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
      }),
    );

    const out = await capture(() => runDeploy([], false));

    assert.equal(calls[0].init?.method, "POST");
    assert.match(calls[0].url, /\/api\/apps\/demo-app\/deploy$/);
    assert.ok(calls[0].init?.body instanceof FormData, "deploy uploads multipart FormData");
    assert.match(out, /Deployment successful/);
    assert.match(out, /Version: v7/);
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
