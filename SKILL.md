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

- `CAPY_SECRET` — preferred token (sandbox environments)
- `CAPY_AUTH_TOKEN` or `MANAGEMENT_API_TOKEN` — fallback tokens
- `CAPY_USER_ID` — required for `create` only when `CAPY_SECRET` is not set
- `CAPY_API_URL` — optional; defaults to `https://api.happycapy.host`; set only for non-production testing
- CLI source: `https://github.com/trickleai/capy-app-dev.git`
- Default scaffold: `https://github.com/trickleai/capy-scaffold-default.git`

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
node dist/index.js list          # active apps only
node dist/index.js list --all    # include suspended/deleted rows too
```

Ownership is scoped to the caller's account.

8. Delete the app (destructive — requires explicit confirmation):

```bash
node dist/index.js delete --yes
```

`delete` removes the deployed worker and routing (URL stops serving), but preserves the registry record, app name, and D1 data. Requires `--yes`; without it the command refuses with `CONFIRMATION_REQUIRED` and makes no network call.

## Managing env vars

Env vars are **plain text** (visible in the Cloudflare dashboard) — non-sensitive config only, no secrets. Values must be **strings**; a non-string value in `.capy-app.json`'s `env` fails with `INVALID_PROJECT_CONFIG`.

**Two ways to set them:**

Option A — via `.capy-app.json` (applied on next `deploy`):
```json
{
  "appName": "my-app",
  "url": "https://my-app.happycapy.host",
  "env": { "APP_TITLE": "My App", "MODE": "production" }
}
```

Option B — directly against the registry (takes effect on next `deploy`):
```bash
node dist/index.js env list                  # show stored vars (NAME + value)
node dist/index.js env set APP_TITLE "Hi"    # upsert one var
node dist/index.js env unset APP_TITLE       # remove one var
```

**Persistence is accumulate/merge.** A deploy overwrites keys it sends and keeps any previously-stored keys that are omitted. `env unset` is the supported way to remove a var — omitting a key from `.capy-app.json` does not remove it.

`env set`/`env unset` also mirror the change into `.capy-app.json` so a later deploy won't overwrite with a stale local value.

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
node dist/index.js deploy              # preview-only after first deploy
node dist/index.js publish             # promote latest preview to live
node dist/index.js publish abc123      # promote specific version to live
node dist/index.js rollback abc123     # roll back to a specific version
node dist/index.js versions            # list all versions
```

## Machine-readable output

Append `--json` to any command (`create`, `init`, `deploy`, `status`, `list`,
`delete`, `publish`, `rollback`, `versions`, `env list/set/unset`) for structured output.

## Notes

- The CLI does not expose Cloudflare credentials to the sandbox.
- `deploy` depends only on the build output contract and `deploy.json`, not on the default scaffold.
- If `deploy.json` contains `database.migrations`, the platform manages D1 creation and incremental migrations automatically.
- Database requests require real D1-backed persistence via `c.env.DB`. Ensure the build output includes `deploy.json.database.migrations`, the server code actually reads and writes through `c.env.DB`, and the post-deploy status confirms `database.id` exists.
- After changing the default scaffold schema, run `npm run db:generate` before `npm run build`.
- If `.capy-app.json` is missing, run `create` before `deploy` or `status`.

## Handling errors

Every command exits non-zero on failure; `--json` emits `{ "success": false, "error": { "code", "message" } }`. Branch on `error.code`, not message text.

| Code | HTTP | Action |
|------|------|--------|
| `APP_QUOTA_EXCEEDED` | 402 | Plan limit reached. **Do not retry or rename.** Tell the user to upgrade their plan or delete an unused app to free a slot. |
| `APP_NAME_TAKEN` | 409 | Name in use. Pick a different name and retry `create`. |
| `CONFIRMATION_REQUIRED` | — | `delete` called without `--yes`. Re-run with `--yes`. |
| `MISSING_PROJECT_CONFIG` | — | `.capy-app.json` not found. Run `create` first. |
| `INVALID_PROJECT_CONFIG` | — | `.capy-app.json` is malformed (e.g. `env` is not an object of string values). Fix the file, then retry. |
