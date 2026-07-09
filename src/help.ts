import { CliError } from "./errors.ts";

export function writeHelp(): void {
  process.stdout.write(`capy-app-dev

Usage:
  capy-app-dev create <app-name> [--json]
  capy-app-dev init [--dir <path>] [--json]
  capy-app-dev deploy [--dir <path>] [--json]
  capy-app-dev status [--json]
  capy-app-dev list [--all] [--json]
  capy-app-dev delete [--hard] [--yes] [--json]
  capy-app-dev secret list [--json]
  capy-app-dev secret set <NAME> <VALUE> [--json]
  capy-app-dev secret unset <NAME> [--json]
  capy-app-dev env list [--json]  [deprecated, use secret]
  capy-app-dev env set <NAME> <VALUE> [--json]  [deprecated, use secret]
  capy-app-dev env unset <NAME> [--json]  [deprecated, use secret]
  capy-app-dev publish [deployId] [--json]
  capy-app-dev rollback <deployId> [--with-data] [--yes] [--json]
  capy-app-dev versions [--json]
  capy-app-dev save [--dir <path>] [-m <message>] [--json]
  capy-app-dev version
  capy-app-dev help

Environment:
  CAPY_API_URL     Optional. Defaults to the production API (https://api.happycapy.host).
                   Set explicitly to target a non-production environment.
  CAPY_SECRET      Preferred sandbox token for API calls
  CAPY_AUTH_TOKEN  Legacy token for API calls
  MANAGEMENT_API_TOKEN  Accepted fallback token name for API calls
  CAPY_USER_ID     Required for create when CAPY_SECRET is not set
  CAPY_DEFAULT_SCAFFOLD_PATH  Optional local scaffold path override for init
  CAPY_DEFAULT_SCAFFOLD_REPO  Optional scaffold repo override for init
  CAPY_DEFAULT_SCAFFOLD_REF   Optional git ref for scaffold repo clone
`);
}

export function handleError(error: unknown, json: boolean): never {
  const cliError =
    error instanceof CliError
      ? error
      : new CliError(error instanceof Error ? error.message : "Unknown error");

  if (json) {
    process.stderr.write(
      `${JSON.stringify({
        success: false,
        error: {
          code: cliError.code,
          message: cliError.message,
        },
      })}\n`,
    );
  } else {
    process.stderr.write(`Error: ${cliError.message}\n`);
  }

  process.exit(cliError.exitCode);
}
