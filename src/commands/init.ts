import { cp, mkdir } from "node:fs/promises";
import path from "node:path";

import { parseDirOption } from "../args.ts";
import { CONFIG_FILE_NAME } from "../constants.ts";
import { CliError } from "../errors.ts";
import { listSourceEntries, pathExists } from "../fs-utils.ts";
import { writeJson } from "../json.ts";
import { resolveDefaultScaffoldSource } from "../scaffold.ts";

export async function runInit(args: string[], json: boolean): Promise<void> {
  const { dir } = parseDirOption(args, "init");
  const targetDir = path.resolve(process.cwd(), dir ?? ".");
  const scaffold = await resolveDefaultScaffoldSource();
  const sourceEntries = await listSourceEntries(scaffold.root);
  const conflicts: string[] = [];

  try {
    for (const relativePath of sourceEntries) {
      const destinationPath = path.join(targetDir, relativePath);
      if (!(await pathExists(destinationPath))) {
        continue;
      }

      if (relativePath === CONFIG_FILE_NAME) {
        continue;
      }

      conflicts.push(relativePath);
    }

    if (conflicts.length > 0) {
      throw new CliError(
        `Init would overwrite existing files: ${conflicts.slice(0, 5).join(", ")}${conflicts.length > 5 ? ", ..." : ""}`,
        { code: "INIT_CONFLICT" },
      );
    }

    await mkdir(targetDir, { recursive: true });

    for (const relativePath of sourceEntries) {
      if (
        relativePath === CONFIG_FILE_NAME &&
        (await pathExists(path.join(targetDir, relativePath)))
      ) {
        continue;
      }

      const sourcePath = path.join(scaffold.root, relativePath);
      const destinationPath = path.join(targetDir, relativePath);
      await mkdir(path.dirname(destinationPath), { recursive: true });
      await cp(sourcePath, destinationPath, { recursive: true });
    }

    if (json) {
      writeJson({
        success: true,
        directory: targetDir,
        scaffold: "default-app",
        source: scaffold.label,
      });
      return;
    }

    process.stdout.write(`Initializing scaffold in ${targetDir} from ${scaffold.label}... done\n`);
    process.stdout.write('Run "npm install" to install dependencies.\n');
  } finally {
    await scaffold.cleanup?.();
  }
}
