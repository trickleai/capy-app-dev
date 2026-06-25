import type { DeployManifest, SandboxIdentityResponse } from "./types.ts";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
