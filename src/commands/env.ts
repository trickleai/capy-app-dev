import path from "node:path";

import { apiRequest, getApiContext } from "../api.ts";
import { readProjectConfig } from "../config.ts";
import { CONFIG_FILE_NAME } from "../constants.ts";
import { CliError } from "../errors.ts";
import { writeJsonFile } from "../fs-utils.ts";
import { isEnvListResponse, isEnvSetResponse, isEnvUnsetResponse } from "../guards.ts";
import { writeJson } from "../json.ts";
import type { EnvListResponse, EnvSetResponse, EnvUnsetResponse, ProjectConfig } from "../types.ts";

/**
 * `env` — manage an app's plain (non-secret) env vars directly on the registry
 * (the platform's source of truth). Changes here take effect on the NEXT deploy,
 * when the stored vars are merged back into the worker's bindings. Sub-commands:
 * `list` / `set <NAME> <VALUE>` / `unset <NAME>`.
 */
export async function runEnv(args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await runEnvList(rest, json);
      return;
    case "set":
      await runEnvSet(rest, json);
      return;
    case "unset":
      await runEnvUnset(rest, json);
      return;
    default:
      throw new CliError("Usage: capy-app-dev env <list|set|unset> ...", {
        code: "INVALID_USAGE",
        exitCode: 2,
      });
  }
}

/** `env list` — GET the app's stored env vars and print them (table or --json). */
async function runEnvList(rest: string[], json: boolean): Promise<void> {
  if (rest.length > 0) {
    throw new CliError("Usage: capy-app-dev env list [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();
  const response = await apiRequest<EnvListResponse>(api, {
    method: "GET",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/env`,
  });

  if (!isEnvListResponse(response)) {
    throw new CliError("Unexpected response from env list API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  if (json) {
    writeJson({ success: true, env: response.env });
    return;
  }

  const entries = Object.entries(response.env);
  if (entries.length === 0) {
    process.stdout.write("No env vars.\n");
    return;
  }

  writeHumanTable(entries);
}

/** Prints a compact aligned table: NAME  VALUE */
function writeHumanTable(entries: [string, string][]): void {
  const header = ["NAME", "VALUE"];
  const widths = header.map((h, i) =>
    Math.max(h.length, ...entries.map((entry) => entry[i].length)),
  );
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join("  ")
      .trimEnd();

  process.stdout.write(`${line(header)}\n`);
  for (const [name, value] of entries) {
    process.stdout.write(`${line([name, value])}\n`);
  }
}

/**
 * `env set <NAME> <VALUE>` — upsert one env var on the registry and mirror it
 * into the local `.capy-app.json` so the next deploy doesn't merge a stale value
 * back over it. VALUE may contain spaces/`=`: the shell already collapsed it into
 * one argument, so it is taken verbatim (no `NAME=VALUE` splitting).
 */
async function runEnvSet(rest: string[], json: boolean): Promise<void> {
  if (rest.length < 2) {
    throw new CliError("Usage: capy-app-dev env set <NAME> <VALUE> [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const name = rest[0];
  const value = rest[1];

  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();
  const response = await apiRequest<EnvSetResponse>(api, {
    method: "PUT",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/env/${encodeURIComponent(name)}`,
    json: { value },
  });

  if (!isEnvSetResponse(response)) {
    throw new CliError("Unexpected response from env set API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  const updated: ProjectConfig = { ...config, env: { ...config.env, [name]: value } };
  await writeJsonFile(path.resolve(process.cwd(), CONFIG_FILE_NAME), updated);

  if (json) {
    writeJson({ success: true, name, value });
    return;
  }

  process.stdout.write(`Set env "${name}" (takes effect on next deploy)\n`);
}

/**
 * `env unset <NAME>` — delete one env var from the registry (idempotent) and
 * remove it from the local `.capy-app.json`. If the local `env` becomes empty the
 * field is dropped entirely, matching the deploy path's "omit when empty" shape.
 */
async function runEnvUnset(rest: string[], json: boolean): Promise<void> {
  if (rest.length < 1) {
    throw new CliError("Usage: capy-app-dev env unset <NAME> [--json]", {
      code: "INVALID_USAGE",
      exitCode: 2,
    });
  }

  const name = rest[0];

  const config = await readProjectConfig(process.cwd());
  const api = await getApiContext();
  const response = await apiRequest<EnvUnsetResponse>(api, {
    method: "DELETE",
    pathname: `/api/apps/${encodeURIComponent(config.appName)}/env/${encodeURIComponent(name)}`,
  });

  if (!isEnvUnsetResponse(response)) {
    throw new CliError("Unexpected response from env unset API", {
      code: "INVALID_API_RESPONSE",
    });
  }

  const nextEnv = { ...config.env };
  delete nextEnv[name];
  const updated: ProjectConfig = { ...config };
  if (Object.keys(nextEnv).length > 0) {
    updated.env = nextEnv;
  } else {
    delete updated.env;
  }
  await writeJsonFile(path.resolve(process.cwd(), CONFIG_FILE_NAME), updated);

  if (json) {
    writeJson({ success: true, name, deleted: response.deleted });
    return;
  }

  process.stdout.write(`Unset env "${name}" (takes effect on next deploy)\n`);
}
