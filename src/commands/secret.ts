import { CliError } from "../errors.ts";
import { runEnvList, runEnvSet, runEnvUnset } from "./env.ts";

/**
 * `secret` — manage an app's plain (non-secret) env vars on the registry.
 * This is the canonical replacement for the deprecated `env` command.
 * Sub-commands: `list` / `set <NAME> <VALUE>` / `unset <NAME>`.
 */
export async function runSecret(args: string[], json: boolean): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "list":
      await runEnvList(rest, json);
      return;
    case "set":
      await runEnvSet(rest, json);
      return;
    case "unset":
      await runEnvUnset(rest, json);
      return;
    default:
      throw new CliError("Usage: capy-app-dev secret <list|set|unset> ...", {
        code: "INVALID_USAGE",
        exitCode: 2,
      });
  }
}
