# capy-app-dev

CLI for sandbox environments that wraps the capy app platform management APIs.

## Commands

```bash
capy-app-dev create <app-name>
capy-app-dev init [--dir <path>]
capy-app-dev deploy [--dir <path>]
capy-app-dev status
```

## Environment Variables

- `CAPY_API_URL` - optional, defaults to `https://api.samdy.run`
- `CAPY_AUTH_TOKEN` - required for API calls
- `CAPY_USER_ID` - required for `create`

## Local Development

```bash
npm install
npm run typecheck
npm run build
node dist/index.js help
```
