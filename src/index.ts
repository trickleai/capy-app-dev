import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { extractJsonFlag, hasHelpFlag } from "./args.ts";
import { runCreate } from "./commands/create.ts";
import { runDelete } from "./commands/delete.ts";
import { runDeploy } from "./commands/deploy.ts";
import { runEnv } from "./commands/env.ts";
import { runInit } from "./commands/init.ts";
import { runList } from "./commands/list.ts";
import { runPublish } from "./commands/publish.ts";
import { runRollback } from "./commands/rollback.ts";
import { runSave } from "./commands/save.ts";
import { runSecret } from "./commands/secret.ts";
import { runStatus } from "./commands/status.ts";
import { runVersions } from "./commands/versions.ts";
import { readPackageVersion } from "./env.ts";
import { CliError } from "./errors.ts";
import { handleError, writeHelp } from "./help.ts";

export {
  apiRequest,
  fetchWithTimeout,
  getApiContext,
  resetSandboxIdentityCache,
  resolveSandboxIdentity,
} from "./api.ts";
export { extractJsonFlag, hasHelpFlag, parseDirOption } from "./args.ts";
export { runCreate } from "./commands/create.ts";
export { runDelete } from "./commands/delete.ts";
export { buildDeployConfig, runDeploy } from "./commands/deploy.ts";
export { runEnv } from "./commands/env.ts";
export { runInit } from "./commands/init.ts";
export { runList } from "./commands/list.ts";
export { runPublish } from "./commands/publish.ts";
export { runRollback } from "./commands/rollback.ts";
export { runSave } from "./commands/save.ts";
export { runSecret } from "./commands/secret.ts";
export { runStatus } from "./commands/status.ts";
export { runVersions } from "./commands/versions.ts";
export { getFirstConfiguredEnvValue, readPackageVersion } from "./env.ts";
// Public surface — re-exported so consumers (and the test suite) can keep
// importing every symbol from "./index.ts" after the split into modules.
export { ApiError, CliError } from "./errors.ts";
export { normalizeRelativePath, resolveInsideRoot } from "./fs-utils.ts";
export {
  isAppStatusResponse,
  isCreateAppResponse,
  isDeployManifest,
  isDeployResponse,
  isEnvListResponse,
  isEnvSetResponse,
  isEnvUnsetResponse,
  isListAppsResponse,
  isPublishResponse,
  isRecord,
  isRollbackResponse,
  isSandboxIdentityResponse,
  isStringRecord,
  isVersionsResponse,
} from "./guards.ts";
export { parseJson, readApiErrorMessage } from "./json.ts";
export type { JsonParseResult } from "./types.ts";
export { validateAppName } from "./validation.ts";

async function main(): Promise<void> {
  const { json, args } = extractJsonFlag(process.argv.slice(2));
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    writeHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    process.stdout.write(`${await readPackageVersion()}\n`);
    return;
  }

  // `-h`/`--help` after a subcommand (e.g. `create -h`) shows usage instead of
  // being misread as a positional argument.
  if (hasHelpFlag(rest)) {
    writeHelp();
    return;
  }

  try {
    switch (command) {
      case "create":
        await runCreate(rest, json);
        return;
      case "init":
        await runInit(rest, json);
        return;
      case "deploy":
        await runDeploy(rest, json);
        return;
      case "status":
        await runStatus(rest, json);
        return;
      case "list":
        await runList(rest, json);
        return;
      case "delete":
        await runDelete(rest, json);
        return;
      case "secret":
        await runSecret(rest, json);
        return;
      case "env":
        await runEnv(rest, json);
        return;
      case "publish":
        await runPublish(rest, json);
        return;
      case "rollback":
        await runRollback(rest, json);
        return;
      case "versions":
        await runVersions(rest, json);
        return;
      case "save":
        await runSave(rest, json);
        return;
      default:
        throw new CliError(`Unknown command: ${command}`, { code: "INVALID_COMMAND", exitCode: 2 });
    }
  } catch (error) {
    handleError(error, json);
  }
}

/**
 * Only auto-run when this module is the process entry point. When imported by a
 * test file the guard is false, so `main()` does not fire on import.
 */
function isMainModule(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }

  try {
    return realpathSync(entry) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isMainModule()) {
  void main();
}
