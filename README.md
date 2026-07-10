# capy-app-dev

CLI for sandbox environments that wraps the capy app platform management APIs.

This package is intended to be published from `https://github.com/trickleai/capy-app-dev.git`.

In Happycapy, this CLI is meant to be called by the agent as part of the normal app-development flow. Users should describe the app they want; the agent decides when to create, build, deploy, and check status.

## Installation

```bash
mkdir -p .capy-cli
curl -fsSL \
  https://github.com/trickleai/capy-app-dev/releases/latest/download/capy-app-dev.js \
  -o .capy-cli/index.js
```

The CLI lives in `.capy-cli/` (not `dist/`) so that `npm run build` — which clears and repopulates `dist/` — does not overwrite it.

## Commands

```bash
# App lifecycle
node .capy-cli/index.js create <app-name>
node .capy-cli/index.js init [--dir <path>]
node .capy-cli/index.js deploy -m <message> [--dir <path>] [--json]
node .capy-cli/index.js save -m <message> [--dir <path>] [--json]
node .capy-cli/index.js status [--json]
node .capy-cli/index.js list [--all] [--json]
node .capy-cli/index.js delete [--hard] [--yes] [--json]

# Versioned deploy workflow (preview-first model)
node .capy-cli/index.js publish [<deployId>] [--json]   # promote preview to live
node .capy-cli/index.js rollback <deployId> [--with-data] [--yes] [--json]
node .capy-cli/index.js versions [--json]               # list all deployment versions

# Env vars / secrets
node .capy-cli/index.js secret list [--json]
node .capy-cli/index.js secret set <name> <value>
node .capy-cli/index.js secret unset <name>

# Meta
node .capy-cli/index.js version   # also --version, -v
node .capy-cli/index.js help
```

Requires Node.js >= 22.

## Versioned deploy workflow

capy-app uses a **preview-first, two-slot** deploy model. Each app has a fixed
**live** slot (main URL) and **preview** slot (`previewUrl`). `deploy` writes the
preview slot; `publish` copies a version into the live slot.

1. **deploy** — uploads the new version to the **preview slot only**, always — **including the first deploy** (`published` is `false`, the live URL is unchanged). Accessible at `previewUrl`; go live with `publish`.
2. **publish [deployId]** — promotes a version to the live slot. Omit `deployId` to publish the latest preview.
3. **rollback \<deployId\>** — re-deploys a previous version into the **preview slot** for review (does not change the live URL by itself; `publish` afterward to go live). Pass `--with-data --yes` to also restore the D1 database to the deploy-time snapshot (destructive — post-deploy writes since that version are lost).
4. **versions** — lists all deployment versions with their status, preview URL, and timestamp.

## Delete lifecycle

```bash
node .capy-cli/index.js delete --yes               # soft-delete
node .capy-cli/index.js delete --hard --yes        # hard-delete
```

**Soft-delete** (`--yes`): removes the deployed worker and routing so the URL stops
serving. The registry row, app name, and D1 database are preserved. The name is
locked and cannot be reused.

**Hard-delete** (`--hard --yes`): irreversibly removes ALL resources — CF version
scripts, KV routing, the D1 database and all its data, deployment history, env
vars, and the registry row. The app name is released for reuse. **Data is
permanently unrecoverable.** Omitting `--yes` exits with `CONFIRMATION_REQUIRED`
without making any network call.

## Environment Variables

- `CAPY_API_URL` — optional, defaults to `https://api.happycapy.host`. Set for non-production environments.
- `CAPY_SECRET` — preferred sandbox token; used to resolve `user_id` automatically.
- `CAPY_AUTH_TOKEN` — legacy fallback token for non-sandbox environments.
- `MANAGEMENT_API_TOKEN` — accepted legacy fallback token.
- `CAPY_USER_ID` — required for `create` only when `CAPY_SECRET` is not set.
- `CAPY_DEFAULT_SCAFFOLD_PATH` — optional local scaffold checkout override for `init`.
- `CAPY_DEFAULT_SCAFFOLD_REPO` — optional public scaffold repo override for `init`.
- `CAPY_DEFAULT_SCAFFOLD_REF` — optional git ref for the scaffold repo clone.

## Local Development

Requires Node.js >= 22 (see `.nvmrc`). With nvm/fnm:

```bash
nvm use            # switches to the Node version pinned in .nvmrc
npm install
npm run typecheck
npm test
npm run build
node dist/index.js help
```

This package includes a local `.npmrc` with `include=dev`, so `npm install` still installs the build toolchain in production-biased sandbox environments.

### Linting & formatting

[Biome](https://biomejs.dev) handles both linting and formatting (single dev dependency, configured in `biome.json`):

```bash
npm run lint     # lint only
npm run format   # format in place
npm run check    # lint + format + organize imports, applying safe fixes
npm run ci       # verify lint + format without writing (use in CI)
```

## Default Scaffold

By default, `capy-app-dev init` fetches the public scaffold repository:

`https://github.com/trickleai/capy-scaffold-default.git`

For monorepo or local development, set `CAPY_DEFAULT_SCAFFOLD_PATH` to a local scaffold checkout instead.

The default scaffold is expected to produce a self-contained client `index.html` so preview deployments do not rely on correct JS/CSS MIME handling from platform asset delivery.

## Database Workflow

If the build output `deploy.json` includes:

```json
{
  "database": {
    "migrations": "migrations"
  }
}
```

then `capy-app-dev deploy` will package that migrations directory together with the Worker and static assets. The platform will create or reuse the app's D1 database, apply pending migrations, and report the database result in both text and `--json` output.

When using the default scaffold, the normal flow is:

```bash
npm install
npm run db:generate
npm run build
node .capy-cli/index.js deploy -m "describe what changed"
```

`deploy` requires a `-m "<message>"` and auto-saves the project source as a
versioned snapshot before uploading the build (best-effort — skipped with a
warning if the code API is unavailable). An empty message is rejected locally
(`MISSING_MESSAGE`, exit 2).

## Env vars / secrets

Env vars are stored in the platform registry (encrypted at rest) and snapshotted into the worker's bindings at deploy time. Persistence uses **accumulate/merge semantics** — a redeploy that omits a previously-set key keeps the stored value. Use `secret unset` to remove a key.

```bash
node .capy-cli/index.js secret list                  # show stored vars
node .capy-cli/index.js secret set APP_TITLE "Hello" # upsert one var
node .capy-cli/index.js secret unset APP_TITLE       # remove one var
```

`secret set`/`secret unset` also mirror the change into `.capy-app.json` so a later deploy won't overwrite with a stale local value.

> **Note:** `env` is a deprecated alias for `secret`. Use `secret` for all new workflows.
