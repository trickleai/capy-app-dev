import { CliError } from "./errors.ts";

export function extractJsonFlag(args: string[]): { json: boolean; args: string[] } {
  return {
    json: args.includes("--json"),
    args: args.filter((arg) => arg !== "--json"),
  };
}

/** True if a `-h` or `--help` flag appears in the given args. */
export function hasHelpFlag(args: string[]): boolean {
  return args.includes("-h") || args.includes("--help");
}

export function parseDirOption(args: string[], command: string): { dir?: string } {
  const usageError = () =>
    new CliError(`Usage: capy-app-dev ${command} [--dir <path>]`, {
      code: "INVALID_USAGE",
      exitCode: 2,
    });

  if (args.length === 0) {
    return {};
  }

  let value: string | undefined;
  if (args.length === 2 && args[0] === "--dir") {
    value = args[1];
  } else if (args.length === 1 && args[0].startsWith("--dir=")) {
    value = args[0].slice("--dir=".length);
  } else {
    throw usageError();
  }

  // An explicitly-provided but empty/whitespace value (`--dir=` or `--dir ""`)
  // would otherwise pass through `dir ?? default` and silently retarget to cwd.
  // Reject it loudly instead of degrading to the wrong directory.
  if (value.trim() === "") {
    throw usageError();
  }

  return { dir: value };
}
