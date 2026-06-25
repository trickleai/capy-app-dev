export interface ProjectConfig {
  appName: string;
  url: string;
  createdAt?: string;
}

export interface DeploymentInfo {
  appName: string;
  url: string;
  version: string;
  assetsCount: number;
  deployedAt: string;
  database?: DeploymentDatabaseInfo;
}

export interface DeploymentDatabaseInfo {
  id: string;
  name: string;
  migrationsApplied: number;
}

export interface AppStatusResponse {
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

export interface AppDatabaseInfo {
  id: string;
  name: string;
}

export interface CreateAppResponse {
  success: true;
  app: {
    appName: string;
    url: string;
    createdAt: string;
  };
}

export interface DeployResponse {
  success: true;
  deployment: DeploymentInfo;
}

export interface SandboxIdentityResponse {
  valid: boolean;
  user_id?: string;
  sandbox_id?: string;
  issued_at?: string;
}

export interface SandboxIdentity {
  userId: string;
  sandboxId: string;
  issuedAt?: string;
  token: string;
}

export interface DeployManifest {
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

export interface DeployPackageResult {
  archivePath: string;
  archiveName: string;
  tempRoot: string;
  workerEntry: string | null;
  assetsDirectory: string | null;
  assetsCount: number;
  databaseMigrationsDirectory: string | null;
  databaseMigrationFiles: number;
}

export interface ScaffoldSource {
  root: string;
  label: string;
  cleanup?: () => Promise<void>;
}

/**
 * Result of `parseJson`. A discriminated union so a successfully parsed `null`
 * body (`{ ok: true, value: null }`) is distinguishable from a parse failure
 * (`{ ok: false }`) — previously both collapsed to `null`.
 */
export type JsonParseResult = { ok: true; value: unknown } | { ok: false };
