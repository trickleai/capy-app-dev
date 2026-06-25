import { APP_NAME_PATTERN, RESERVED_SUBDOMAINS } from "./constants.ts";
import { CliError } from "./errors.ts";

export function validateAppName(appName: string): void {
  if (appName.length < 3 || appName.length > 63) {
    throw new CliError("App name must be 3-63 characters long", {
      code: "INVALID_APP_NAME",
    });
  }

  if (!APP_NAME_PATTERN.test(appName)) {
    throw new CliError(
      "App name must use lowercase letters, numbers, and hyphens, and must start and end with a letter or number",
      { code: "INVALID_APP_NAME" },
    );
  }

  if (RESERVED_SUBDOMAINS.has(appName)) {
    throw new CliError("App name is reserved", {
      code: "INVALID_APP_NAME",
    });
  }
}
