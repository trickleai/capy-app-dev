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
  if (args.length === 0) {
    return {};
  }

  if (args.length === 2 && args[0] === "--dir") {
    return { dir: args[1] };
  }

  if (args.length === 1 && args[0].startsWith("--dir=")) {
    return { dir: args[0].slice("--dir=".length) };
  }

  throw new CliError(`Usage: capy-app-dev ${command} [--dir <path>]`, {
    code: "INVALID_USAGE",
    exitCode: 2,
  });
}
