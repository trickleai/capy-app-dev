import type {
  AppDatabaseInfo,
  AppStatusResponse,
  AppSummary,
  CodeIgnoreResponse,
  CodeSnapshotInfo,
  CodeSyncCommitResponse,
  CodeSyncPlanResponse,
  CreateAppResponse,
  DeleteResponse,
  DeployManifest,
  DeploymentDatabaseInfo,
  DeploymentInfo,
  DeployResponse,
  EnvListResponse,
  EnvSetResponse,
  EnvUnsetResponse,
  ListAppsResponse,
  PublishResponse,
  RollbackResponse,
  SandboxIdentityResponse,
  VersionEntry,
  VersionsResponse,
} from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * True when `value` is a flat object whose every value is a string. Used to
 * validate the optional `env` block in `.capy-app.json`: Cloudflare worker
 * `vars` accept string values only.
 */
export function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === "string");
}

export function isDeployManifest(value: unknown): value is DeployManifest {
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

export function isSandboxIdentityResponse(value: unknown): value is SandboxIdentityResponse {
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

/** Deployment `database` block returned by the deploy API. */
function isDeploymentDatabaseInfo(value: unknown): value is DeploymentDatabaseInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    typeof value.migrationsApplied === "number"
  );
}

/** App-level `database` block returned by the status API (no migrationsApplied). */
function isAppDatabaseInfo(value: unknown): value is AppDatabaseInfo {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string";
}

/** Validates only the deployment fields the CLI dereferences. */
function isDeploymentInfo(value: unknown): value is DeploymentInfo {
  if (!isRecord(value)) {
    return false;
  }

  if (
    typeof value.appName !== "string" ||
    typeof value.url !== "string" ||
    typeof value.version !== "string" ||
    typeof value.assetsCount !== "number" ||
    typeof value.deployedAt !== "string"
  ) {
    return false;
  }

  if (
    value.database !== undefined &&
    value.database !== null &&
    !isDeploymentDatabaseInfo(value.database)
  ) {
    return false;
  }

  return true;
}

export function isCreateAppResponse(value: unknown): value is CreateAppResponse {
  if (!isRecord(value) || !isRecord(value.app)) {
    return false;
  }

  const app = value.app;
  return (
    typeof app.appName === "string" &&
    typeof app.url === "string" &&
    typeof app.createdAt === "string"
  );
}

export function isDeployResponse(value: unknown): value is DeployResponse {
  return (
    isRecord(value) &&
    isDeploymentInfo(value.deployment) &&
    typeof value.previewUrl === "string" &&
    typeof value.deployId === "string" &&
    typeof value.published === "boolean"
  );
}

export function isPublishResponse(value: unknown): value is PublishResponse {
  return (
    isRecord(value) &&
    typeof value.appName === "string" &&
    typeof value.deployId === "string" &&
    typeof value.url === "string"
  );
}

export function isRollbackResponse(value: unknown): value is RollbackResponse {
  if (
    !isRecord(value) ||
    typeof value.appName !== "string" ||
    typeof value.deployId !== "string" ||
    typeof value.url !== "string"
  ) {
    return false;
  }

  if (value.withData !== undefined && typeof value.withData !== "boolean") {
    return false;
  }

  return true;
}

function isVersionEntry(value: unknown): value is VersionEntry {
  return (
    isRecord(value) &&
    typeof value.deployId === "string" &&
    typeof value.version === "string" &&
    typeof value.workerName === "string" &&
    typeof value.status === "string" &&
    typeof value.previewUrl === "string" &&
    typeof value.createdAt === "string"
  );
}

export function isVersionsResponse(value: unknown): value is VersionsResponse {
  return (
    isRecord(value) &&
    typeof value.appName === "string" &&
    Array.isArray(value.versions) &&
    value.versions.every(isVersionEntry)
  );
}

export function isDeleteResponse(value: unknown): value is DeleteResponse {
  return isRecord(value) && typeof value.appName === "string" && typeof value.status === "string";
}

/** Validates one row of a `GET /api/apps` listing. */
function isAppSummary(value: unknown): value is AppSummary {
  if (!isRecord(value)) {
    return false;
  }
  if (
    typeof value.appName !== "string" ||
    typeof value.status !== "string" ||
    typeof value.workerName !== "string" ||
    typeof value.url !== "string" ||
    typeof value.createdAt !== "string"
  ) {
    return false;
  }
  if (
    value.lastDeployedAt !== undefined &&
    value.lastDeployedAt !== null &&
    typeof value.lastDeployedAt !== "string"
  ) {
    return false;
  }
  if (
    value.lastVersion !== undefined &&
    value.lastVersion !== null &&
    typeof value.lastVersion !== "string"
  ) {
    return false;
  }
  return true;
}

export function isListAppsResponse(value: unknown): value is ListAppsResponse {
  return isRecord(value) && Array.isArray(value.apps) && value.apps.every(isAppSummary);
}

export function isEnvListResponse(value: unknown): value is EnvListResponse {
  return isRecord(value) && typeof value.appName === "string" && isStringRecord(value.env);
}

export function isEnvSetResponse(value: unknown): value is EnvSetResponse {
  return isRecord(value) && typeof value.appName === "string" && typeof value.name === "string";
}

export function isEnvUnsetResponse(value: unknown): value is EnvUnsetResponse {
  return (
    isRecord(value) &&
    typeof value.appName === "string" &&
    typeof value.name === "string" &&
    typeof value.deleted === "boolean"
  );
}

export function isAppStatusResponse(value: unknown): value is AppStatusResponse {
  if (!isRecord(value) || !isRecord(value.app)) {
    return false;
  }

  const app = value.app;
  if (
    typeof app.appName !== "string" ||
    typeof app.url !== "string" ||
    typeof app.createdAt !== "string"
  ) {
    return false;
  }

  // deployment and database are nullable; only validate the shape when present.
  if (
    app.deployment !== null &&
    app.deployment !== undefined &&
    !isDeploymentInfo(app.deployment)
  ) {
    return false;
  }

  if (app.database !== null && app.database !== undefined && !isAppDatabaseInfo(app.database)) {
    return false;
  }

  return true;
}

function isCodeSnapshotInfo(value: unknown): value is CodeSnapshotInfo {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.message === null || typeof value.message === "string") &&
    typeof value.fileCount === "number" &&
    typeof value.sizeBytes === "number" &&
    typeof value.createdAt === "string"
  );
}

export function isCodeSyncPlanResponse(value: unknown): value is CodeSyncPlanResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.missing) &&
    value.missing.every((h) => typeof h === "string") &&
    typeof value.ignored === "number"
  );
}

export function isCodeSyncCommitResponse(value: unknown): value is CodeSyncCommitResponse {
  return (
    isRecord(value) &&
    value.success === true &&
    typeof value.created === "number" &&
    typeof value.updated === "number" &&
    typeof value.deleted === "number" &&
    isCodeSnapshotInfo(value.snapshot)
  );
}

export function isCodeIgnoreResponse(value: unknown): value is CodeIgnoreResponse {
  return (
    isRecord(value) &&
    Array.isArray(value.patterns) &&
    value.patterns.every((p) => typeof p === "string")
  );
}
