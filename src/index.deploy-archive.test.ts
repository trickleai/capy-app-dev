import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { createDeployArchive } from "./deploy-archive.ts";
import { CliError } from "./errors.ts";

/**
 * Regression tests for the temp-dir leak (audit H2). `createDeployArchive`
 * mkdtemp()s a working dir up front; on any throw after that it must remove the
 * dir (the caller's cleanup only runs for a successfully returned tempRoot). On
 * success the dir must survive so `runDeploy` can read the archive and clean up.
 */

const TMP = tmpdir();
const listWorkDirs = (): string[] =>
  readdirSync(TMP).filter((name) => name.startsWith("capy-app-dev-"));
const countWorkDirs = (): number => listWorkDirs().length;

let buildDir = "";
let workDirsBefore = new Set<string>();

beforeEach(() => {
  buildDir = mkdtempSync(path.join(TMP, "h2-build-"));
  // Snapshot pre-existing work dirs so afterEach can remove only the ones this
  // test caused — a safety net so a regression (fix reverted) fails loudly
  // WITHOUT leaving leaked dirs behind in the system temp directory.
  workDirsBefore = new Set(listWorkDirs());
});

afterEach(() => {
  rmSync(buildDir, { recursive: true, force: true });
  for (const name of listWorkDirs()) {
    if (!workDirsBefore.has(name)) {
      rmSync(path.join(TMP, name), { recursive: true, force: true });
    }
  }
});

describe("createDeployArchive temp-dir lifecycle (H2)", () => {
  it("removes its temp dir when it throws after mkdtemp", async () => {
    // deploy.json references a worker entry that does not exist on disk, so
    // createDeployArchive throws MISSING_DEPLOY_ARTIFACT after mkdtemp.
    writeFileSync(
      path.join(buildDir, "deploy.json"),
      JSON.stringify({ worker: { entry: "server/does-not-exist.js" } }),
    );

    const before = countWorkDirs();
    await assert.rejects(createDeployArchive(buildDir), (err: unknown) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.code, "MISSING_DEPLOY_ARTIFACT");
      return true;
    });
    const after = countWorkDirs();

    assert.equal(after, before, "createDeployArchive must not leak a temp dir on error");
  });

  it("keeps the returned tempRoot on success for the caller to clean up", async () => {
    // A minimal valid build: deploy.json + the referenced worker entry.
    await mkdir(path.join(buildDir, "server"), { recursive: true });
    await writeFile(path.join(buildDir, "server", "index.js"), "export default {};\n");
    await writeFile(
      path.join(buildDir, "deploy.json"),
      JSON.stringify({ worker: { entry: "server/index.js" } }),
    );

    const result = await createDeployArchive(buildDir);
    try {
      // The temp dir and the archive inside it must still exist — the success
      // path intentionally does NOT clean up (runDeploy does, afterwards).
      assert.ok(existsSync(result.tempRoot), "tempRoot should exist after a successful call");
      assert.ok(existsSync(result.archivePath), "archive should exist inside tempRoot");
      assert.equal(result.workerEntry, "server/index.js");
    } finally {
      rmSync(result.tempRoot, { recursive: true, force: true });
    }
  });
});
