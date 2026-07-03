# capy-app-dev

Use this skill when an agent needs to create, initialize, build, deploy, or check the status of an app on the capy app platform from inside a sandbox.

## Trigger Conditions

Trigger this skill when the user intent is to build, modify, or ship an application, for example:

- Build me a web app
- Create a dashboard / admin panel / landing page that should be previewable
- Start from a scaffold or app template and deploy it
- Update an existing app, rebuild it, and refresh the preview URL
- Build an app that needs a database, persistent storage, D1, Drizzle, SQL, saved user content, or data that must still exist after refresh/redeploy

Do not wait for the user to explicitly say "deploy". The agent should decide to create and deploy when the task is clearly an application-development workflow.
When the user explicitly asks for a database or persistence, treat D1-backed persistence as required, not optional.

## Preconditions

- `CAPY_SECRET` should be present in sandbox environments and is the preferred token source
- `CAPY_AUTH_TOKEN` is retained as a fallback token name for non-sandbox environments
- `MANAGEMENT_API_TOKEN` is also accepted as a fallback token name
- `CAPY_USER_ID` must be present for `create` only when `CAPY_SECRET` is not set
- `CAPY_API_URL` is optional and defaults to the production API (`https://api.happycapy.host`); only set it when explicitly testing against a non-production environment
- the CLI should be built from `https://github.com/trickleai/capy-app-dev.git`
- the default scaffold lives at `https://github.com/trickleai/capy-scaffold-default.git`

## Agent Workflow

1. Decide whether to use the default scaffold or clone a task-specific template repository.
2. If the task starts from scratch, use the default scaffold.
3. If the task already has a repo or template requirement, clone/copy that source instead.
4. If the user requires a database, implement the app against Cloudflare D1 via `c.env.DB`, define the schema with Drizzle, and generate migrations.
5. Generate or choose a unique app name and create the remote app record before deploy.
6. Build the project and deploy the build output through the platform API.
7. Verify the deployment result and app status show database metadata when D1 was required.
8. Return the preview URL and deployment status to the user.

## Command Workflow

1. Build the CLI:

```bash
npm install
npm run build
```

2. Create the remote app record:

```bash
node dist/index.js create <app-name>
```

This writes `.capy-app.json` in the current directory.

#### Passing plain environment variables to the worker

To expose runtime configuration to the deployed worker, add an optional `env`
object to `.capy-app.json` (string keys and string values only):

```json
{
  "appName": "my-app",
  "url": "https://my-app.happycapy.host",
  "env": {
    "APP_TITLE": "My App",
    "MODE": "production"
  }
}
```

On `deploy`, each entry under `env` is converted into a Cloudflare `plain_text`
binding and sent in the deploy `config`, so the platform exposes it to the
worker at runtime. The worker reads them via `env.APP_TITLE` (Hono:
`c.env.APP_TITLE`).

**Persistence is accumulate/merge, not replace.** The platform remembers env
vars across deploys: a redeploy applies the keys present in this deploy's `env`
(a supplied key overwrites its stored value) and **keeps** any previously-stored
keys that are omitted this time. Dropping a key from `.capy-app.json`'s `env`
therefore does **not** unset it on the worker — the last value stays live. To
change a value, set it to the new value; to remove a binding, use
`env unset <NAME>` (see "Managing env vars directly" below).

> **Agent gotcha:** removing a key from `env` and redeploying will **not**
> delete it — the previously-deployed value keeps serving, and you'll see the
> "old" value stick around. This is expected, not a bug. Never rely on
> "delete the key + redeploy" to clear a variable. To actually remove one, run
> `env unset <NAME>` (it deletes the stored value; the worker stops serving it
> on the next deploy). To change a value, set it to the new value.

These are **plain text** (visible in the Cloudflare dashboard) — use them for
non-sensitive config only. Do not put secrets (API keys, tokens) here. Values
must be strings; a non-string value makes `deploy` fail with
`INVALID_PROJECT_CONFIG`.

3. Initialize the default scaffold if the project has not been created yet:

```bash
node dist/index.js init
```

By default `init` fetches the public default scaffold repository. For local development, `CAPY_DEFAULT_SCAFFOLD_PATH` can point at a local checkout instead.

The default scaffold is expected to emit a self-contained client `index.html` so preview deployments remain usable even if platform asset responses have incorrect MIME types for module JS or CSS.

4. Install dependencies and build the app:

```bash
npm install
npm run db:generate   # when src/server/db/schema.ts changed
npm run build
```

The bundled CLI package and default scaffold both include a local `.npmrc` with `include=dev`, so you should not need to override `NODE_ENV` just to install build dependencies.

If the user asked for a database, do not skip `npm run db:generate` after schema work.

5. Deploy the build output:

```bash
node dist/index.js deploy
```

By default the CLI deploys from `./dist`. Use `--dir <path>` for a different build output directory.

6. Check the current remote status:

```bash
node dist/index.js status
```

When D1 is required, prefer `node dist/index.js deploy --json` and `node dist/index.js status --json` so the agent can verify that `database.id` and `database.name` were returned.

7. List the account's apps:

```bash
node dist/index.js list          # active apps only (name, status, url, last-deployed)
node dist/index.js list --all    # include suspended/deleted rows too
```

Useful when the user is not in a project directory or asks about apps created in
another conversation. Ownership is scoped to the caller's account — the endpoint
only returns apps that belong to the authenticated user/team.

8. Delete the app (destructive — requires explicit confirmation):

```bash
node dist/index.js delete --yes
```

`delete` stops the app: it removes the deployed worker and its routing so the URL
stops serving (the platform keeps the registry record and the app name, and
preserves any D1 data). Because it is destructive and the CLI is non-interactive,
it **requires `--yes`** — without it the command refuses with
`CONFIRMATION_REQUIRED` and makes no network call. Only run `delete` when the user
has clearly asked to delete/remove the app. `.capy-app.json` is left in place;
remove it manually if the link is no longer needed.

### Managing env vars directly

Instead of hand-editing `.capy-app.json`'s `env` block, manage individual vars
against the registry (the platform's source of truth):

```bash
node dist/index.js env list                 # show stored vars (NAME + value)
node dist/index.js env set APP_TITLE "Hi"    # upsert one var
node dist/index.js env unset APP_TITLE       # remove one var
```

These edit the **stored** env set and **take effect on the next `deploy`** (the
platform merges the stored vars back into the worker's bindings at deploy time —
they do not hot-update the running worker). `env set`/`env unset` also mirror the
change into the local `.capy-app.json` so a later deploy won't merge a stale value
back over it. `env unset` is the supported way to remove a var — omitting a key
from `.capy-app.json` does not remove it (see the gotcha above). Same plain-text
caveat applies: these are visible in the Cloudflare dashboard, so never store
secrets here.

## Versioned deploy workflow

capy-app uses a preview-first deploy model:

1. **deploy** — uploads the new version. The **first-ever deploy auto-publishes**
   (live immediately; no need to call `publish`). Subsequent deploys are
   **preview-only**: accessible at `previewUrl` but the live URL is unchanged.
2. **publish [deployId]** — promotes a preview version to live. Omit `deployId`
   to publish the latest preview; pass an explicit `deployId` to publish a
   specific version.
3. **rollback \<deployId\>** — restores a previously-live version. Requires an
   explicit `deployId` (find one with `versions`). **Does not roll back data**
   — the D1 database is unchanged.
4. **versions** — lists all deployment versions with their status, preview URL,
   and timestamp.

```bash
# Deploy (preview-only after first deploy)
node dist/index.js deploy

# Promote the latest preview to live
node dist/index.js publish

# Promote a specific version to live
node dist/index.js publish abc123

# Roll back to a specific version
node dist/index.js rollback abc123

# List all versions
node dist/index.js versions
node dist/index.js versions --json
```

## Machine-readable output

Append `--json` to `create`, `init`, `deploy`, `status`, `list`, `delete`,
`publish`, `rollback`, `versions`, or the `env` subcommands (`env list` /
`env set` / `env unset`) when an agent needs structured output.

## Notes

- The CLI does not expose Cloudflare credentials to the sandbox.
- `deploy` depends only on the build output contract and `deploy.json`, not on the default scaffold.
- If `deploy.json` contains `database.migrations`, the platform will manage D1 creation and incremental migration execution automatically.
- If the user asks for a database, persistence, or saved data, the agent must ship a real D1-backed implementation. In-memory stores, module-level arrays, mock repositories, and `localStorage`-only persistence do not satisfy that requirement.
- For database-backed apps, ensure the build output includes `deploy.json.database.migrations`, the server code actually reads and writes through `c.env.DB`, and the post-deploy status confirms database metadata exists.
- After changing the default scaffold schema, run `npm run db:generate` before `npm run build`.
- If `.capy-app.json` is missing, run `create` before `deploy` or `status`.
- The agent should call this skill as part of the normal app-building flow, not as a separate user-driven deployment ceremony.

## Handling errors

Every command exits non-zero on failure and prints `Error: <message>`; with
`--json` it prints `{ "success": false, "error": { "code", "message" } }`.
Branch on `error.code`, not on message text. Two `create` errors need specific
handling:

### `APP_QUOTA_EXCEEDED` (HTTP 402) — plan limit reached

`create` returns this when the account has reached the number of apps allowed by
its current plan. Example message: `App limit reached for your plan (3). Upgrade
to create more apps.`

This is an **account/plan-level** limit (total active apps for the user or
team), **not** a problem with the chosen app name. **Do not retry, and do not
rename and retry — it will keep failing.** Instead, the agent should clearly
tell the user they have hit their plan's app limit and **suggest upgrading their
plan** to create more apps (or deleting an unused app to free a slot). Phrase it
as a helpful next step, e.g. "You've reached the app limit for your current plan
— upgrading your plan will let you deploy more apps." Surface the upgrade
suggestion proactively whenever this error occurs.

### `APP_NAME_TAKEN` (HTTP 409) — name already in use

The chosen app name is taken. Unlike the quota error, this **is** fixed by
choosing a different name: pick another unique app name and retry `create`.

> Distinguish the two: **409 `APP_NAME_TAKEN` → rename and retry; 402
> `APP_QUOTA_EXCEEDED` → stop and suggest a plan upgrade.**
