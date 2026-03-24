# capy-app-dev

CLI for sandbox environments that wraps the capy app platform management APIs.

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
- `CAPY_AUTH_TOKEN` - preferred token name for API calls
- `MANAGEMENT_API_TOKEN` - accepted fallback token name for API calls
- `CAPY_USER_ID` - required for `create`

## Local Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js help
```
