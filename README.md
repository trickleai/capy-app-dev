# capy-app-dev

CLI for sandbox environments that wraps the capy app platform management APIs.

This package is intended to be published from `https://github.com/trickleai/capy-app-dev.git`.

In Happycapy, this CLI is meant to be called by the agent as part of the normal app-development flow. Users should describe the app they want; the agent decides when to create, build, deploy, and check status.

## Commands

```bash
capy-app-dev create <app-name>
capy-app-dev init [--dir <path>]
capy-app-dev deploy [--dir <path>]
capy-app-dev status
```

## Environment Variables

- `CAPY_API_URL` - optional, defaults to `https://api.samdy.run`
- `CAPY_SECRET` - preferred sandbox token name for API calls; used to resolve `user_id` automatically
- `CAPY_AUTH_TOKEN` - legacy fallback token name for API calls outside sandbox environments
- `MANAGEMENT_API_TOKEN` - accepted legacy fallback token name for API calls
- `CAPY_USER_ID` - required for `create` only when `CAPY_SECRET` is not set
- `CAPY_DEFAULT_SCAFFOLD_PATH` - optional local scaffold checkout override for `init`
- `CAPY_DEFAULT_SCAFFOLD_REPO` - optional public scaffold repo override for `init`
- `CAPY_DEFAULT_SCAFFOLD_REF` - optional git ref for the scaffold repo clone

## Local Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js help
```

This package includes a local `.npmrc` with `include=dev`, so `npm install` still installs the build toolchain in production-biased sandbox environments.

## Default Scaffold

By default, `capy-app-dev init` fetches the public scaffold repository:

`https://github.com/trickleai/capy-scaffold-default.git`

For monorepo or local development, set `CAPY_DEFAULT_SCAFFOLD_PATH` to a local scaffold checkout instead.

The default scaffold is expected to produce a self-contained client `index.html` so preview deployments do not rely on correct JS/CSS MIME handling from platform asset delivery.
