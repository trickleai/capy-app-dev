import { CliError } from "./errors.ts";

export function writeHelp(): void {
  process.stdout.write(`capy-app-dev

Usage:
  capy-app-dev create <app-name> [--json]
  capy-app-dev init [--dir <path>] [--json]
  capy-app-dev deploy [--dir <path>] [--json]
  capy-app-dev status [--json]
  capy-app-dev version
  capy-app-dev help

Environment:
  CAPY_API_URL     Optional. Defaults to https://api.samdy.run
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
