import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const CONFIG_FILE_NAME = ".capy-app.json";
const DEFAULT_API_URL = "https://api.samdy.run";
const DEFAULT_SCAFFOLD_REPO_URL = "https://github.com/trickleai/capy-scaffold-default.git";
const RESERVED_SUBDOMAINS = new Set(["www", "api", "admin", "dashboard", "docs", "status"]);
const APP_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SCAFFOLD_IGNORE_NAMES = new Set([".DS_Store", "dist", "node_modules", ".git"]);
const LEGACY_AUTH_TOKEN_ENV_NAMES = ["CAPY_AUTH_TOKEN", "MANAGEMENT_API_TOKEN"] as const;
const SANDBOX_SECRET_ENV_NAME = "CAPY_SECRET";
const DEFAULT_SCAFFOLD_PATH_ENV = "CAPY_DEFAULT_SCAFFOLD_PATH";
const DEFAULT_SCAFFOLD_REPO_ENV = "CAPY_DEFAULT_SCAFFOLD_REPO";
const DEFAULT_SCAFFOLD_REF_ENV = "CAPY_DEFAULT_SCAFFOLD_REF";

interface ProjectConfig {
  appName: string;
  url: string;
  createdAt?: string;
}

interface DeploymentInfo {
  appName: string;
  url: string;
  version: string;
  assetsCount: number;
  deployedAt: string;
  database?: DeploymentDatabaseInfo;
}

interface DeploymentDatabaseInfo {
  id: string;
  name: string;
  migrationsApplied: number;
}

interface AppStatusResponse {
  success: true;
  app: {
    appName: string;
    userId: string;
    workerName: string;
    url: string;
    createdAt: string;
    deployment: DeploymentInfo | null;
    database: AppDatabaseInfo | null;
  };
}

interface AppDatabaseInfo {
  id: string;
  name: string;
}

interface CreateAppResponse {
  success: true;
  app: {
    appName: string;
    url: string;
    createdAt: string;
  };
}

interface DeployResponse {
  success: true;
  deployment: DeploymentInfo;
}

interface SandboxIdentityResponse {
  valid: boolean;
  user_id?: string;
  sandbox_id?: string;
  issued_at?: string;
}

interface SandboxIdentity {
  userId: string;
  sandboxId: string;
  issuedAt?: string;
  token: string;
}

interface DeployManifest {
  worker?: {
    entry: string;
    modules?: string[];
  };
  assets?: {
    directory: string;
  };
  database?: {
    migrations: string;
  };
}

interface DeployPackageResult {
  archivePath: string;
  archiveName: string;
  tempRoot: string;
  workerEntry: string | null;
  assetsDirectory: string | null;
  assetsCount: number;
  databaseMigrationsDirectory: string | null;
  databaseMigrationFiles: number;
}

interface ScaffoldSource {
  root: string;
  label: string;
  cleanup?: () => Promise<void>;
}

class CliError extends Error {
  code: string;
  exitCode: number;

  constructor(message: string, options?: { code?: string; exitCode?: number }) {
    super(message);
    this.code = options?.code ?? "CLI_ERROR";
    this.exitCode = options?.exitCode ?? 1;
  }
}

class ApiError extends CliError {
  status: number;

  constructor(status: number, code: string, message: string) {
    super(message, { code });
    this.status = status;
  }
}

let cachedSandboxIdentity: SandboxIdentity | null = null;

async function main(): Promise<void> {
  const { json, args } = extractJsonFlag(process.argv.slice(2));
  const [command, ...rest] = args;

  if (!command || command === "help" || command === "--help" || command === "-h") {
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
      default:
        throw new CliError(`Unknown command: ${command}`, { code: "INVALID_COMMAND", exitCode: 2 });
    }
  } catch (error) {
    handleError(error, json);
  }
}

async function runCreate(args: string[], json: boolean): Promise<void> {
  if (args.length !== 1) {
    throw new CliError('Usage: capy-app-dev create <app-name>', {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const appName = args[0]?.trim();
  if (!appName) {
    throw new CliError("app name is required", { code: "INVALID_APP_NAME", exitCode: 2 });
  }

  validateAppName(appName);

  const configPath = path.resolve(process.cwd(), CONFIG_FILE_NAME);
  if (await pathExists(configPath)) {
    throw new CliError(
      `Found existing ${CONFIG_FILE_NAME}. This directory is already linked to an app.`,
      { code: "CONFIG_ALREADY_EXISTS" },
    );
  }

  const api = await getApiContext({ requireUserId: true });
  if (!api.userId) {
    throw new CliError("CAPY_USER_ID is required for create", {
      code: "MISSING_USER_ID",
    });
  }

  const response = await apiRequest<CreateAppResponse>(api, {
    method: "POST",
    pathname: "/api/apps",
    json: {
      appName,
      userId: api.userId,
    },
  });

  const config: ProjectConfig = {
    appName: response.app.appName,
    url: response.app.url,
    createdAt: response.app.createdAt,
  };

  await writeJsonFile(configPath, config);

  if (json) {
    writeJson({
      success: true,
      appName: config.appName,
      url: config.url,
      createdAt: config.createdAt,
    });
    return;
  }

  process.stdout.write(`Creating app "${config.appName}"... done\n`);
  process.stdout.write(`URL: ${config.url}\n`);
}

async function runInit(args: string[], json: boolean): Promise<void> {
  const { dir } = parseDirOption(args, "init");
  const targetDir = path.resolve(process.cwd(), dir ?? ".");
  const scaffold = await resolveDefaultScaffoldSource();
  const sourceEntries = await listSourceEntries(scaffold.root);
  const conflicts: string[] = [];

  try {
    for (const relativePath of sourceEntries) {
      const destinationPath = path.join(targetDir, relativePath);
      if (!(await pathExists(destinationPath))) {
        continue;
      }

      if (relativePath === CONFIG_FILE_NAME) {
        continue;
      }

      conflicts.push(relativePath);
    }

    if (conflicts.length > 0) {
      throw new CliError(
        `Init would overwrite existing files: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", ..." : ""}`,
        { code: "INIT_CONFLICT" },
      );
    }

    await mkdir(targetDir, { recursive: true });

    for (const relativePath of sourceEntries) {
      if (relativePath === CONFIG_FILE_NAME && (await pathExists(path.join(targetDir, relativePath)))) {
        continue;
      }

      const sourcePath = path.join(scaffold.root, relativePath);
      const destinationPath = path.join(targetDir, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath, { recursive: true });
    }

    if (json) {
      writeJson({
        success: true,
        directory: targetDir,
        scaffold: "default-app",
        source: scaffold.label,
      });
      return;
    }

    process.stdout.write(`Initializing scaffold in ${targetDir} from ${scaffold.label}... done\n`);
    process.stdout.write('Run "npm install" to install dependencies.\n');
  } finally {
    await scaffold.cleanup?.();
  }
}

async function runDeploy(args: string[], json: boolean): Promise<void> {
  const { dir } = parseDirOption(args, "deploy");
  const api = await getApiContext();
  const config = await readProjectConfig(process.cwd());
  const buildDir = path.resolve(process.cwd(), dir ?? "dist");
  const deployPackage = await createDeployArchive(buildDir);

  try {
    const formData = new FormData();
    const archiveContents = await readFile(deployPackage.archivePath);
    formData.set(
      "archive",
      new File([archiveContents], deployPackage.archiveName, {
        type: "application/gzip",
      }),
    );

    const response = await apiRequest<DeployResponse>(api, {
      method: "POST",
      pathname: `/api/apps/${encodeURIComponent(config.appName)}/deploy`,
      body: formData,
    });

    if (json) {
      writeJson({
        success: true,
        appName: response.deployment.appName,
        url: response.deployment.url,
        version: response.deployment.version,
        assetsCount: response.deployment.assetsCount,
        deployedAt: response.deployment.deployedAt,
        database: response.deployment.database ?? null,
      });
      return;
    }

    process.stdout.write("Packaging build output...\n");
    if (deployPackage.workerEntry) {
      process.stdout.write(`  Worker entry: ${deployPackage.workerEntry}\n`);
    } else {
      process.stdout.write("  Worker entry: auto-generated asset worker\n");
    }
    if (deployPackage.assetsDirectory) {
      process.stdout.write(
        `  Assets directory: ${deployPackage.assetsDirectory} (${deployPackage.assetsCount} files)\n`,
      );
    } else {
      process.stdout.write("  Assets directory: none\n");
    }
    if (deployPackage.databaseMigrationsDirectory) {
      process.stdout.write(
        `  Database migrations: ${deployPackage.databaseMigrationsDirectory} (${deployPackage.databaseMigrationFiles} files)\n`,
      );
    } else {
      process.stdout.write("  Database migrations: none\n");
    }
    process.stdout.write(`Deploying to ${config.appName}... done\n\n`);
    process.stdout.write("Deployment successful:\n");
    process.stdout.write(`  URL: ${response.deployment.url}\n`);
    process.stdout.write(`  Version: ${response.deployment.version}\n`);
    process.stdout.write(`  Assets: ${response.deployment.assetsCount} files\n`);
    if (response.deployment.database) {
      process.stdout.write(
        `  Database: ${response.deployment.database.name} (${response.deployment.database.migrationsApplied} migrations applied)\n`,
      );
    }
  } finally {
    await rm(deployPackage.tempRoot, { recursive: true, force: true });
  }
}

async function runStatus(args: string[], json: boolean): Promise<void> {
  if (args.length > 0) {
    throw new CliError('Usage: capy-app-dev status', {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const api = await getApiContext();
  const config = await readProjectConfig(process.cwd());
  const response = await apiRequest<AppStatusResponse>(api, {
    method: "GET",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}`,
  });

  if (json) {
    writeJson({
      success: true,
      appName: response.app.appName,
      url: response.app.url,
      createdAt: response.app.createdAt,
      deployment: response.app.deployment,
      database: response.app.database,
    });
    return;
  }

  process.stdout.write(`App: ${response.app.appName}\n`);
  process.stdout.write(`URL: ${response.app.url}\n`);
  process.stdout.write(`Created: ${response.app.createdAt}\n`);
  process.stdout.write(
    `Last deployed: ${response.app.deployment?.deployedAt ?? "never"}\n`,
  );
  if (response.app.deployment) {
    process.stdout.write(`Version: ${response.app.deployment.version}\n`);
  }
  if (response.app.database) {
    process.stdout.write(`Database: ${response.app.database.name}\n`);
  }
}

function extractJsonFlag(args: string[]): { json: boolean; args: string[] } {
  return {
    json: args.includes("--json"),
    args: args.filter((arg) => arg !== "--json"),
  };
}

function parseDirOption(args: string[], command: string): { dir?: string } {
  if (args.length === 0) {
    return {};
  }

  if (args.length === 2 && args[0] === "--dir") {
    return { dir: args[1] };
  }

  if (args.length === 1 && args[0].startsWith("--dir=")) {
    return { dir: args[0].slice("--dir=".length) };
  }

  throw new CliError(`Usage: capy-app-dev ${command} [--dir <path>]`, {
    code: "INVALID_USAGE",
    exitCode: 2,
  });
}

async function getApiContext(options?: { requireUserId?: boolean }): Promise<{
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

async function resolveSandboxIdentity(
  baseUrl: URL,
  token: string,
): Promise<SandboxIdentity> {
  if (cachedSandboxIdentity?.token === token) {
    return cachedSandboxIdentity;
  }

  const response = await fetch(new URL("/internal/validate-sandbox-token", baseUrl), {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
    },
    body: JSON.stringify({ token }),
  });

  const rawText = await response.text();
  const payload = parseJson(rawText);

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

async function apiRequest<T>(
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

  const response = await fetch(url, {
    method: options.method,
    headers,
    body,
  });

  const rawText = await response.text();
  const payload = parseJson(rawText);

  if (!response.ok) {
    const errorCode = isRecord(payload) && isRecord(payload.error) && typeof payload.error.code === "string"
      ? payload.error.code
      : `HTTP_${response.status}`;
    const errorMessage = readApiErrorMessage(payload, response.status);
    throw new ApiError(response.status, errorCode, errorMessage);
  }

  if (!payload) {
    throw new CliError(`API returned invalid JSON for ${url.pathname}`, {
      code: "INVALID_API_RESPONSE",
    });
  }

  return payload as T;
}

async function readProjectConfig(cwd: string): Promise<ProjectConfig> {
  const configPath = path.join(cwd, CONFIG_FILE_NAME);

  let rawConfig: string;
  try {
    rawConfig = await readFile(configPath, "utf8");
  } catch {
    throw new CliError(
      `No ${CONFIG_FILE_NAME} found. Run "capy-app-dev create <app-name>" first.`,
      { code: "MISSING_PROJECT_CONFIG" },
    );
  }

  const config = parseJson(rawConfig);
  if (
    !isRecord(config) ||
    typeof config.appName !== "string" ||
    typeof config.url !== "string"
  ) {
    throw new CliError(`${CONFIG_FILE_NAME} is invalid`, {
      code: "INVALID_PROJECT_CONFIG",
    });
  }

  return {
    appName: config.appName,
    url: config.url,
    createdAt: typeof config.createdAt === "string" ? config.createdAt : undefined,
  };
}

async function createDeployArchive(buildDir: string): Promise<DeployPackageResult> {
  const buildStats = await stat(buildDir).catch(() => null);
  if (!buildStats || !buildStats.isDirectory()) {
    throw new CliError(`Build directory not found: ${buildDir}`, {
      code: "BUILD_DIR_NOT_FOUND",
    });
  }

  const manifestPath = path.join(buildDir, "deploy.json");
  let rawManifest: string;
  try {
    rawManifest = await readFile(manifestPath, "utf8");
  } catch {
    throw new CliError(
      `No deploy.json found in ${buildDir}\nHint: Run your build command first. The default scaffold emits deploy.json from build-server.ts; custom projects must generate dist/deploy.json with worker.entry and/or assets.directory.`,
      { code: "MISSING_DEPLOY_MANIFEST" },
    );
  }

  const manifest = parseJson(rawManifest);
  if (!isDeployManifest(manifest)) {
    throw new CliError("deploy.json is invalid", {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  if (!manifest.worker?.entry && !manifest.assets?.directory) {
    throw new CliError("deploy.json must define worker.entry or assets.directory", {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), "capy-app-dev-"));
  const stageDir = path.join(tempRoot, "stage");
  const archivePath = path.join(tempRoot, "deploy.tar.gz");
  await mkdir(stageDir, { recursive: true });

  const copied = new Set<string>();
  await copyRelativePath(buildDir, stageDir, "deploy.json", copied);

  let workerEntry: string | null = null;
  if (manifest.worker?.entry) {
    workerEntry = manifest.worker.entry;
    await copyRelativePath(buildDir, stageDir, manifest.worker.entry, copied);
  }

  if (manifest.worker?.modules) {
    for (const modulePath of manifest.worker.modules) {
      await copyRelativePath(buildDir, stageDir, modulePath, copied);
    }
  }

  let assetsDirectory: string | null = null;
  let assetsCount = 0;
  if (manifest.assets?.directory) {
    assetsDirectory = manifest.assets.directory;
    assetsCount = await countFiles(
      resolveInsideRoot(buildDir, manifest.assets.directory, "assets.directory"),
    );
    await copyRelativePath(buildDir, stageDir, manifest.assets.directory, copied);
  }

  let databaseMigrationsDirectory: string | null = null;
  let databaseMigrationFiles = 0;
  if (manifest.database?.migrations) {
    databaseMigrationsDirectory = manifest.database.migrations;
    databaseMigrationFiles = await countDirectoryFiles(
      resolveInsideRoot(buildDir, manifest.database.migrations, "database.migrations"),
      "database.migrations",
    );
    await copyRelativePath(buildDir, stageDir, manifest.database.migrations, copied);
  }

  try {
    await execFileAsync("tar", ["-czf", archivePath, "-C", stageDir, "."]);
  } catch (error) {
    throw new CliError(
      error instanceof Error ? error.message : "Failed to create deploy archive",
      { code: "ARCHIVE_CREATE_FAILED" },
    );
  }

  return {
    archivePath,
    archiveName: "deploy.tar.gz",
    tempRoot,
    workerEntry,
    assetsDirectory,
    assetsCount,
    databaseMigrationsDirectory,
    databaseMigrationFiles,
  };
}

async function copyRelativePath(
  rootDir: string,
  destinationRoot: string,
  relativePath: string,
  copied: Set<string>,
): Promise<void> {
  const normalized = normalizeRelativePath(relativePath);
  if (copied.has(normalized)) {
    return;
  }

  const sourcePath = resolveInsideRoot(rootDir, relativePath, "deploy artifact");
  const sourceStats = await lstat(sourcePath).catch(() => null);
  if (!sourceStats) {
    throw new CliError(`Referenced deploy artifact is missing: ${relativePath}`, {
      code: "MISSING_DEPLOY_ARTIFACT",
    });
  }

  const destinationPath = path.join(destinationRoot, normalized);
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await cp(sourcePath, destinationPath, { recursive: true });
  copied.add(normalized);
}

async function listSourceEntries(rootDir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(path.join(rootDir, prefix), { withFileTypes: true });
  const paths: string[] = [];

  for (const entry of entries) {
    if (SCAFFOLD_IGNORE_NAMES.has(entry.name)) {
      continue;
    }

    const relativePath = prefix ? path.posix.join(prefix, entry.name) : entry.name;
    if (entry.isDirectory()) {
      paths.push(...(await listSourceEntries(rootDir, relativePath)));
    } else {
      paths.push(relativePath);
    }
  }

  return paths;
}

async function countFiles(targetPath: string): Promise<number> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats) {
    throw new CliError(`assets.directory is missing: ${targetPath}`, {
      code: "MISSING_ASSETS_DIRECTORY",
    });
  }

  if (targetStats.isFile()) {
    return 1;
  }

  const entries = await readdir(targetPath, { withFileTypes: true });
  let total = 0;

  for (const entry of entries) {
    const entryPath = path.join(targetPath, entry.name);
    if (entry.isDirectory()) {
      total += await countFiles(entryPath);
    } else if (entry.isFile()) {
      total += 1;
    }
  }

  return total;
}

async function countDirectoryFiles(targetPath: string, label: string): Promise<number> {
  const targetStats = await stat(targetPath).catch(() => null);
  if (!targetStats) {
    throw new CliError(`${label} is missing: ${targetPath}`, {
      code: "MISSING_DEPLOY_ARTIFACT",
    });
  }

  if (!targetStats.isDirectory()) {
    throw new CliError(`${label} must point to a directory`, {
      code: "INVALID_DEPLOY_MANIFEST",
    });
  }

  return countFiles(targetPath);
}

function getBundledScaffoldRoot(): string {
  const currentFilePath = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(currentFilePath), "..");
  return path.resolve(packageRoot, "..", "scaffolds", "default-app");
}

async function resolveDefaultScaffoldSource(): Promise<ScaffoldSource> {
  const configuredPath = process.env[DEFAULT_SCAFFOLD_PATH_ENV]?.trim();
  if (configuredPath) {
    const root = path.resolve(configuredPath);
    if (!(await pathExists(root))) {
      throw new CliError(
        `${DEFAULT_SCAFFOLD_PATH_ENV} points to a missing directory: ${root}`,
        { code: "SCAFFOLD_NOT_FOUND" },
      );
    }

    return {
      root,
      label: root,
    };
  }

  const bundledRoot = getBundledScaffoldRoot();
  if (await pathExists(bundledRoot)) {
    return {
      root: bundledRoot,
      label: bundledRoot,
    };
  }

  return downloadDefaultScaffoldRepo();
}

async function downloadDefaultScaffoldRepo(): Promise<ScaffoldSource> {
  const repoUrl = process.env[DEFAULT_SCAFFOLD_REPO_ENV]?.trim() || DEFAULT_SCAFFOLD_REPO_URL;
  const repoRef = process.env[DEFAULT_SCAFFOLD_REF_ENV]?.trim();
  const tempRoot = await mkdtemp(path.join(tmpdir(), "capy-scaffold-default-"));
  const checkoutDir = path.join(tempRoot, "repo");
  const gitArgs = ["clone", "--depth", "1"];

  if (repoRef) {
    gitArgs.push("--branch", repoRef);
  }

  gitArgs.push(repoUrl, checkoutDir);

  try {
    await execFileAsync("git", gitArgs);
  } catch (error) {
    await rm(tempRoot, { recursive: true, force: true });
    throw new CliError(
      `Failed to fetch default scaffold from ${repoUrl}. Configure ${DEFAULT_SCAFFOLD_PATH_ENV} for a local scaffold checkout if needed.`,
      { code: "SCAFFOLD_FETCH_FAILED" },
    );
  }

  return {
    root: checkoutDir,
    label: repoUrl,
    cleanup: async () => {
      await rm(tempRoot, { recursive: true, force: true });
    },
  };
}

function resolveInsideRoot(rootDir: string, relativePath: string, label: string): string {
  const resolvedPath = path.resolve(rootDir, relativePath);
  const normalizedRoot = `${rootDir}${path.sep}`;

  if (resolvedPath !== rootDir && !resolvedPath.startsWith(normalizedRoot)) {
    throw new CliError(`${label} must stay within ${rootDir}`, {
      code: "INVALID_DEPLOY_PATH",
    });
  }

  return resolvedPath;
}

function normalizeRelativePath(relativePath: string): string {
  return relativePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function validateAppName(appName: string): void {
  if (appName.length < 3 || appName.length > 63) {
    throw new CliError("App name must be 3-63 characters long", {
      code: "INVALID_APP_NAME",
    });
  }

  if (!APP_NAME_PATTERN.test(appName)) {
    throw new CliError(
      "App name must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
      { code: "INVALID_APP_NAME" },
    );
  }

  if (RESERVED_SUBDOMAINS.has(appName)) {
    throw new CliError("App name is reserved", {
      code: "INVALID_APP_NAME",
    });
  }
}

function isDeployManifest(value: unknown): value is DeployManifest {
  if (!isRecord(value)) {
    return false;
  }

  if (value.worker !== undefined) {
    if (!isRecord(value.worker) || typeof value.worker.entry !== "string") {
      return false;
    }

    if (
      value.worker.modules !== undefined &&
      (!Array.isArray(value.worker.modules) ||
        value.worker.modules.some((item) => typeof item !== "string"))
    ) {
      return false;
    }
  }

  if (value.assets !== undefined) {
    if (!isRecord(value.assets) || typeof value.assets.directory !== "string") {
      return false;
    }
  }

  if (value.database !== undefined) {
    if (!isRecord(value.database) || typeof value.database.migrations !== "string") {
      return false;
    }
  }

  return true;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSandboxIdentityResponse(value: unknown): value is SandboxIdentityResponse {
  if (!isRecord(value) || typeof value.valid !== "boolean") {
    return false;
  }

  if (value.user_id !== undefined && typeof value.user_id !== "string") {
    return false;
  }

  if (value.sandbox_id !== undefined && typeof value.sandbox_id !== "string") {
    return false;
  }

  if (value.issued_at !== undefined && typeof value.issued_at !== "string") {
    return false;
  }

  return true;
}

function parseJson(rawValue: string): unknown {
  try {
    return JSON.parse(rawValue) as unknown;
  } catch {
    return null;
  }
}

function readApiErrorMessage(payload: unknown, status: number): string {
  if (isRecord(payload)) {
    if (isRecord(payload.error) && typeof payload.error.message === "string") {
      return payload.error.message;
    }

    if (typeof payload.error === "string") {
      return payload.error;
    }
  }

  return `Request failed with status ${status}`;
}

function getFirstConfiguredEnvValue(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) {
      return value;
    }
  }

  return undefined;
}

async function pathExists(targetPath: string): Promise<boolean> {
  return (await lstat(targetPath).catch(() => null)) !== null;
}

async function writeJsonFile(targetPath: string, value: unknown): Promise<void> {
  await writeFile(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function writeHelp(): void {
  process.stdout.write(`capy-app-dev

Usage:
  capy-app-dev create <app-name> [--json]
  capy-app-dev init [--dir <path>] [--json]
  capy-app-dev deploy [--dir <path>] [--json]
  capy-app-dev status [--json]
  capy-app-dev help

Environment:
  CAPY_API_URL     Optional. Defaults to https://api.samdy.run
  CAPY_SECRET      Preferred sandbox token for API calls
  CAPY_AUTH_TOKEN  Legacy token for API calls
  MANAGEMENT_API_TOKEN  Accepted fallback token name for API calls
  CAPY_USER_ID     Required for create when CAPY_SECRET is not set
  CAPY_DEFAULT_SCAFFOLD_PATH  Optional local scaffold path override for init
  CAPY_DEFAULT_SCAFFOLD_REPO  Optional scaffold repo override for init
  CAPY_DEFAULT_SCAFFOLD_REF   Optional git ref for scaffold repo clone
`);
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function handleError(error: unknown, json: boolean): never {
  const cliError = error instanceof CliError
    ? error
    : new CliError(error instanceof Error ? error.message : "Unknown error");

  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        success: false,
        error: {
          code: cliError.code,
          message: cliError.message,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(`Error: ${cliError.message}\n`);
  }

  process.exit(cliError.exitCode);
}

void main();
