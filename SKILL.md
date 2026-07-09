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
6. Build the project, then deploy the build output through the platform API. **Always commit and git-tag each deploy** (see Command Workflow step 5) so every deployment is a recoverable version — do this automatically, without waiting for the user to ask.
7. **`deploy` is preview-only — it never goes live on its own, not even the first time.** To make a version live you must call `publish` (see Command Workflow step 6). For a normal "build and ship it" request, deploy then publish. If the user only wants to preview/review first, deploy and hand back the preview URL without publishing.
8. Verify the deployment result and app status show database metadata when D1 was required.
9. Return the preview URL (and, once published, the live URL) and deployment status to the user.

## Command Workflow

1. Download the CLI (latest release):

```bash
mkdir -p .capy-cli
curl -fsSL \
  https://github.com/trickleai/capy-app-dev/releases/latest/download/capy-app-dev.js \
  -o .capy-cli/index.js
```

The CLI lives in `.capy-cli/` (not `dist/`) so that `npm run build` — which
clears and repopulates `dist/` — does not overwrite it.

2. Create the remote app record:

```bash
node .capy-cli/index.js create <app-name>
```

This writes `.capy-app.json` in the current directory.

3. Initialize the default scaffold if the project has not been created yet:

```bash
node .capy-cli/index.js init
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

5. Deploy the build output. **Always follow this three-step sequence** so every
   deploy is a recoverable version (this is mandatory, not optional — it is how
   the platform's rollback stays usable; see "Versioned deploy workflow"):

   **a. Commit the working tree first.** Init a repo on the very first deploy:
   ```bash
   git init -q                                   # first deploy only
   git add -A && git commit -q -m "deploy: <short description>"
   ```

   **b. Deploy:**
   ```bash
   node .capy-cli/index.js deploy --json
   ```
   (Deploys from `./dist` by default; use `--dir <path>` for another output dir.)

   **c. Tag the commit with the returned `deployId`:**
   ```bash
   git tag "v-<deployId>"                         # deployId from the deploy --json output
   ```

   Do these three every time you deploy — no exceptions. It keeps the sandbox's
   local code (and `.capy-app.json`, including its `env`) aligned with each
   server-side version, so a later `rollback` can be mirrored locally.

   **`deploy` is preview-only.** It uploads to the preview slot and returns a
   `previewUrl`; `published` is `false`. The live URL is NOT updated — this is
   true for **every** deploy, including the first one. Go live with `publish`
   (next step).

6. Publish to make a version live. `deploy` only produces a preview; the live
   URL changes only when you publish:

   ```bash
   node .capy-cli/index.js publish            # publish the latest preview
   node .capy-cli/index.js publish <deployId> # publish a specific version
   ```

   For a normal "build and ship" request, run `publish` right after `deploy`.
   Skip it only when the user explicitly wants to preview/review before going live.

7. Check the current remote status:

```bash
node .capy-cli/index.js status
```

When D1 is required, prefer `node .capy-cli/index.js deploy --json` and `node .capy-cli/index.js status --json` so the agent can verify that `database.id` and `database.name` were returned.

8. List the account's apps:

```bash
node .capy-cli/index.js list          # active apps only
node .capy-cli/index.js list --all    # include suspended/deleted rows too
```

Ownership is scoped to the caller's account.

9. Delete the app (destructive — requires explicit confirmation):

```bash
node .capy-cli/index.js delete --yes               # soft-delete (default)
node .capy-cli/index.js delete --hard --yes        # hard-delete (irreversible)
```

**Soft-delete** (`--yes` only): removes the deployed worker and routing (URL stops
serving immediately), but preserves the registry record, app name, and D1 data.
The app name is locked and cannot be reused.

**Hard-delete** (`--hard --yes`): irreversibly removes ALL resources — all version
scripts, KV routing, the D1 database and its data, deployment history, env vars,
and the registry row. The app name is released for reuse. **D1 data is permanently
lost and cannot be recovered.** Both flags are required; `--hard` alone exits with
`CONFIRMATION_REQUIRED` and makes no network call.

## Managing secrets

Env vars are **plain text** (visible in the Cloudflare dashboard) — non-sensitive config only, no secrets. Values must be **strings**; a non-string value in `.capy-app.json`'s `env` fails with `INVALID_PROJECT_CONFIG`.

> **Note:** The `env` command is a deprecated alias for `secret`. Use `secret` for all new workflows.

**Two ways to set them:**

Option A — via `.capy-app.json` (applied on next `deploy`):
```json
{
  "appName": "my-app",
  "url": "https://my-app.happycapy.host",
  "env": { "APP_TITLE": "My App", "MODE": "production" }
}
```

Option B — directly against the registry (snapshotted into the worker's bindings at the next `deploy` or `publish`):
```bash
node .capy-cli/index.js secret list                  # show stored vars (NAME + value)
node .capy-cli/index.js secret set APP_TITLE "Hi"    # upsert one var
node .capy-cli/index.js secret unset APP_TITLE       # remove one var
```

**Persistence is accumulate/merge.** A deploy overwrites keys it sends and keeps any previously-stored keys that are omitted. `secret unset` is the supported way to remove a var — omitting a key from `.capy-app.json` does not remove it.

**Env vars are snapshotted into the worker's bindings at deploy time.** The currently-live worker only sees the env that was active when it was deployed — `secret set` and `.capy-app.json` edits do **not** hot-update the running worker; they take effect only on the next `deploy` (or `publish`).

`secret set`/`secret unset` also mirror the change into `.capy-app.json` so a later deploy won't overwrite with a stale local value.

## Versioned deploy workflow

capy-app uses a preview-first, two-slot deploy model. Every app has two fixed
worker slots: a **live** slot (served at the app's main URL) and a **preview**
slot (served at `previewUrl`). `deploy` only ever writes the preview slot;
`publish` copies a version into the live slot.

1. **deploy** — uploads the new version to the **preview slot only**. This is
   always preview-only — **including the first-ever deploy** (`published` is
   `false`, the live URL is not created/changed). Accessible at `previewUrl`.
   To go live you must `publish`.
2. **publish [deployId]** — promotes a version to the live slot. Omit `deployId`
   to publish the latest preview; pass an explicit `deployId` to publish a
   specific version.
3. **rollback \<deployId\>** — re-deploys a previous version into the **preview
   slot** for review (it does NOT change the live URL by itself — publish
   afterward to make it live). Requires an explicit `deployId` (find one with
   `versions`). By default **does not roll back data** — the D1 database is
   unchanged. Pass `--with-data --yes` to also restore the D1 database to the
   snapshot captured at that deploy's instant (destructive and irreversible —
   post-deploy writes since that version are lost).
4. **versions** — lists all deployment versions with their status, preview URL,
   and timestamp.

```bash
node .capy-cli/index.js deploy              # preview-only (always, incl. first deploy)
node .capy-cli/index.js publish             # promote latest preview to live
node .capy-cli/index.js publish abc123      # promote specific version to live
node .capy-cli/index.js rollback abc123     # re-deploy abc123 into preview slot
node .capy-cli/index.js rollback abc123 --with-data --yes  # + restore D1 data
node .capy-cli/index.js publish             # then publish to make the rolled-back version live
node .capy-cli/index.js versions            # list all versions
```

### Git tags mirror rollback locally

Because you commit + `git tag "v-<deployId>"` on every deploy (step 5 of the
Command Workflow), each server-side version has a matching local tag. `rollback`
re-deploys the version into the **preview slot** server-side and does **not**
touch sandbox code, so after rolling back, check out the tag to bring the local
project back in step (then `publish` when you're ready to make it live):

```bash
node .capy-cli/index.js rollback <deployId> --json
git checkout "v-<deployId>"
node .capy-cli/index.js publish              # make the rolled-back version live
```

Notes:
- The sandbox git repo is **session-local** — tags do not persist across sandboxes.
- `.capy-app.json` (including its `env` block) is tracked by git, so
  `git checkout v-<deployId>` also restores that version's local env config — and
  because `secret set`/`secret unset` mirror into `.capy-app.json`, the local file is a
  faithful record to check out. A later `deploy` still applies the
  accumulate/merge semantics above (it re-applies the checked-out env over the
  server's stored vars), so this re-applies that version's env rather than
  resetting the server to an exact snapshot.
- Redeploying after a rollback uploads the **current** working tree, which
  supersedes the rolled-back version. Roll back to stop the bleeding, fix forward,
  then deploy again.

## Saving project source (`save`)

`save` backs up the **entire project source tree** to the backend, independent
of deploy. It is content-addressed and incremental: unchanged files are not
re-uploaded, and each save records a versioned snapshot.

```
node .capy-cli/index.js save                       # save the whole workspace (cwd)
node .capy-cli/index.js save -m "before refactor"  # with a commit message
node .capy-cli/index.js save --dir ./app --json     # a specific dir, JSON output
```

- Walks the workspace and **skips ignored paths** (dependency/install dirs like
  `node_modules`, VCS like `.git`, caches, OS junk — build outputs such as
  `dist`/`build` are NOT ignored). The ignore list is fetched from the server
  (`GET .../code/ignore`) so it stays in sync; a built-in fallback is used if
  that call fails.
- Flow: build a manifest → ask the server which blobs are missing → upload only
  those → commit (reconciles the stored tree to match the workspace + records a
  snapshot with the optional message).
- `save` does **not** deploy — it only stores source. Deploy stays a separate step.

## Machine-readable output

Append `--json` to any command (`create`, `init`, `deploy`, `status`, `list`,
`delete`, `publish`, `rollback`, `versions`, `save`, `secret list/set/unset`) for structured output.

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
| `CONFIRMATION_REQUIRED` | — | Destructive command called without required confirmation flag. `delete` → add `--yes`. `delete --hard` → add `--hard --yes`. `rollback --with-data` → add `--with-data --yes`. |
| `MISSING_PROJECT_CONFIG` | — | `.capy-app.json` not found. Run `create` first. |
| `INVALID_PROJECT_CONFIG` | — | `.capy-app.json` is malformed (e.g. `env` is not an object of string values). Fix the file, then retry. |
