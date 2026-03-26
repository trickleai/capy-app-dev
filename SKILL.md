# capy-app-dev

Use this skill when an agent needs to create, initialize, build, deploy, or check the status of an app on the capy app platform from inside a sandbox.

## Trigger Conditions

Trigger this skill when the user intent is to build, modify, or ship an application, for example:

- Build me a web app
- Create a dashboard / admin panel / landing page that should be previewable
- Start from a scaffold or app template and deploy it
- Update an existing app, rebuild it, and refresh the preview URL

Do not wait for the user to explicitly say "deploy". The agent should decide to create and deploy when the task is clearly an application-development workflow.

## Preconditions

- `CAPY_AUTH_TOKEN` should be present in the environment
- `MANAGEMENT_API_TOKEN` is also accepted as a fallback token name
- a sandbox-scoped token mapped from the worker secret `SANDBOX_API_TOKEN` is also valid
- `CAPY_USER_ID` must be present for `create`
- `CAPY_API_URL` is optional and defaults to `https://api.samdy.run`
- the CLI should be built from `https://github.com/trickleai/capy-app-dev.git`
- the default scaffold lives at `https://github.com/trickleai/capy-scaffold-default.git`

## Agent Workflow

1. Decide whether to use the default scaffold or clone a task-specific template repository.
2. If the task starts from scratch, use the default scaffold.
3. If the task already has a repo or template requirement, clone/copy that source instead.
4. Generate or choose a unique app name and create the remote app record before deploy.
5. Build the project and deploy the build output through the platform API.
6. Return the preview URL and deployment status to the user.

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

4. Install dependencies and build the app:

```bash
npm install
npm run build
```

The bundled CLI package and default scaffold both include a local `.npmrc` with `include=dev`, so you should not need to override `NODE_ENV` just to install build dependencies.

5. Deploy the build output:

```bash
node dist/index.js deploy
```

By default the CLI deploys from `./dist`. Use `--dir <path>` for a different build output directory.

6. Check the current remote status:

```bash
node dist/index.js status
```

## Machine-readable output

Append `--json` to `create`, `init`, `deploy`, or `status` when an agent needs structured output.

## Notes

- The CLI does not expose Cloudflare credentials to the sandbox.
- `deploy` depends only on the build output contract and `deploy.json`, not on the default scaffold.
- If `.capy-app.json` is missing, run `create` before `deploy` or `status`.
- The agent should call this skill as part of the normal app-building flow, not as a separate user-driven deployment ceremony.
