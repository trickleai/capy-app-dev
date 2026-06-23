import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";

import {
  CliError,
  extractJsonFlag,
  getFirstConfiguredEnvValue,
  hasHelpFlag,
  isDeployManifest,
  isRecord,
  isSandboxIdentityResponse,
  normalizeRelativePath,
  parseDirOption,
  parseJson,
  readApiErrorMessage,
  readPackageVersion,
  resolveInsideRoot,
  validateAppName,
} from "./index.ts";

describe("extractJsonFlag", () => {
  it("strips --json from anywhere and reports it", () => {
    assert.deepEqual(extractJsonFlag(["deploy", "--json", "--dir", "x"]), {
      json: true,
      args: ["deploy", "--dir", "x"],
    });
  });

  it("is false when absent and leaves args untouched", () => {
    assert.deepEqual(extractJsonFlag(["status"]), { json: false, args: ["status"] });
  });
});

describe("hasHelpFlag", () => {
  it("detects -h and --help anywhere in the args", () => {
    assert.equal(hasHelpFlag(["-h"]), true);
    assert.equal(hasHelpFlag(["--help"]), true);
    assert.equal(hasHelpFlag(["--dir", "x", "-h"]), true);
  });

  it("is false when no help flag is present", () => {
    assert.equal(hasHelpFlag([]), false);
    assert.equal(hasHelpFlag(["my-app"]), false);
  });
});

describe("parseDirOption", () => {
  it("returns empty for no args", () => {
    assert.deepEqual(parseDirOption([], "deploy"), {});
  });

  it("supports --dir <path>", () => {
    assert.deepEqual(parseDirOption(["--dir", "build"], "deploy"), { dir: "build" });
  });

  it("supports --dir=<path>", () => {
    assert.deepEqual(parseDirOption(["--dir=out"], "deploy"), { dir: "out" });
  });

  it("throws INVALID_USAGE (exit 2) on garbage", () => {
    assert.throws(
      () => parseDirOption(["nonsense"], "deploy"),
      (err: unknown) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.code, "INVALID_USAGE");
        assert.equal(err.exitCode, 2);
        return true;
      },
    );
  });
});

describe("validateAppName", () => {
  it("accepts a valid name", () => {
    assert.doesNotThrow(() => validateAppName("my-app-1"));
  });

  it("rejects too short / too long", () => {
    assert.throws(() => validateAppName("ab"), /3-63/);
    assert.throws(() => validateAppName("a".repeat(64)), /3-63/);
  });

  it("rejects bad characters and bad edges", () => {
    assert.throws(
      () => validateAppName("My-App"),
      (e: unknown) => e instanceof CliError && e.code === "INVALID_APP_NAME",
    );
    assert.throws(() => validateAppName("-leading"), /INVALID_APP_NAME|lowercase/);
    assert.throws(() => validateAppName("trailing-"), /lowercase|start and end/);
  });

  it("rejects reserved subdomains", () => {
    assert.throws(() => validateAppName("api"), /reserved/);
    assert.throws(() => validateAppName("www"), /reserved/);
  });
});

describe("resolveInsideRoot (path traversal guard)", () => {
  const root = "/tmp/build";

  it("resolves a child path", () => {
    assert.equal(
      resolveInsideRoot(root, "server/index.js", "x"),
      path.resolve(root, "server/index.js"),
    );
  });

  it("allows the root itself", () => {
    assert.equal(resolveInsideRoot(root, ".", "x"), path.resolve(root));
  });

  it("rejects escaping the root with ..", () => {
    assert.throws(
      () => resolveInsideRoot(root, "../secrets", "deploy artifact"),
      (e: unknown) => {
        assert.ok(e instanceof CliError);
        assert.equal(e.code, "INVALID_DEPLOY_PATH");
        return true;
      },
    );
  });

  it("rejects an absolute path outside the root", () => {
    assert.throws(
      () => resolveInsideRoot(root, "/etc/passwd", "x"),
      /INVALID_DEPLOY_PATH|must stay within/,
    );
  });
});

describe("normalizeRelativePath", () => {
  it("converts backslashes and strips leading ./", () => {
    assert.equal(normalizeRelativePath(".\\a\\b"), "a/b");
    assert.equal(normalizeRelativePath("./c/d"), "c/d");
  });
});

describe("isRecord", () => {
  it("is true only for plain objects", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord(null), false);
    assert.equal(isRecord("s"), false);
  });
});

describe("isDeployManifest", () => {
  it("accepts worker-only and assets-only manifests", () => {
    assert.equal(isDeployManifest({ worker: { entry: "server/index.js" } }), true);
    assert.equal(isDeployManifest({ assets: { directory: "client" } }), true);
  });

  it("accepts a full manifest with modules + database", () => {
    assert.equal(
      isDeployManifest({
        worker: { entry: "s.js", modules: ["a.js"] },
        assets: { directory: "client" },
        database: { migrations: "migrations" },
      }),
      true,
    );
  });

  it("rejects malformed shapes", () => {
    assert.equal(isDeployManifest(null), false);
    assert.equal(isDeployManifest({ worker: {} }), false);
    assert.equal(isDeployManifest({ worker: { entry: 1 } }), false);
    assert.equal(isDeployManifest({ worker: { entry: "s", modules: [1] } }), false);
    assert.equal(isDeployManifest({ assets: { directory: 2 } }), false);
    assert.equal(isDeployManifest({ database: {} }), false);
  });
});

describe("isSandboxIdentityResponse", () => {
  it("accepts a minimal valid response", () => {
    assert.equal(isSandboxIdentityResponse({ valid: true }), true);
    assert.equal(isSandboxIdentityResponse({ valid: false, user_id: "u", sandbox_id: "s" }), true);
  });

  it("rejects wrong field types / missing valid", () => {
    assert.equal(isSandboxIdentityResponse({}), false);
    assert.equal(isSandboxIdentityResponse({ valid: "yes" }), false);
    assert.equal(isSandboxIdentityResponse({ valid: true, user_id: 1 }), false);
  });
});

describe("parseJson", () => {
  it("returns { ok: true, value } for valid JSON", () => {
    assert.deepEqual(parseJson('{"a":1}'), { ok: true, value: { a: 1 } });
  });

  it("returns { ok: false } on invalid JSON", () => {
    assert.deepEqual(parseJson("not json"), { ok: false });
  });

  it("distinguishes a legitimate null body from a parse failure (Bug 3)", () => {
    // A valid JSON `null` must be ok:true with value null — NOT conflated with
    // a parse failure.
    assert.deepEqual(parseJson("null"), { ok: true, value: null });
    assert.deepEqual(parseJson(""), { ok: false });
  });
});

describe("readApiErrorMessage", () => {
  it("reads nested error.message", () => {
    assert.equal(readApiErrorMessage({ error: { message: "boom" } }, 500), "boom");
  });

  it("reads string error", () => {
    assert.equal(readApiErrorMessage({ error: "nope" }, 400), "nope");
  });

  it("falls back to the status", () => {
    assert.equal(readApiErrorMessage({}, 503), "Request failed with status 503");
    assert.equal(readApiErrorMessage(null, 418), "Request failed with status 418");
  });
});

describe("getFirstConfiguredEnvValue", () => {
  it("returns the first non-empty env value", () => {
    const key = "CAPY_TEST_ENV_A";
    const other = "CAPY_TEST_ENV_B";
    delete process.env[key];
    process.env[other] = "  value  ";
    try {
      assert.equal(getFirstConfiguredEnvValue([key, other]), "value");
    } finally {
      delete process.env[other];
    }
  });

  it("returns undefined when none set", () => {
    assert.equal(getFirstConfiguredEnvValue(["CAPY_TEST_ENV_MISSING_X"]), undefined);
  });
});

describe("readPackageVersion", () => {
  it("reads a semver-shaped version from package.json", async () => {
    const version = await readPackageVersion();
    // Reads the real package.json next to the source; must be a concrete version,
    // never the "unknown" fallback.
    assert.notEqual(version, "unknown");
    assert.match(version, /^\d+\.\d+\.\d+/);
  });
});
