import { findProjectRoot } from "@nylorun/core/project";
import { readCredentials, readLink } from "./connection.js";

/** Two `export` lines for `nylo env` (was `nylorun status --env`, F2-7). */
export async function printLinkedEnvExports(
  projectRoot = process.cwd(),
): Promise<void> {
  const root = findProjectRoot(projectRoot) ?? projectRoot;
  const link = await readLink(root);
  const credentials = await readCredentials(root);
  if (!link || !credentials) {
    console.log(
      '# No Project link in this directory. Run "npx nylorun start" in this project to start its Tenant and link it.',
    );
    return;
  }
  console.log(`export NYLORUN_RUNTIME_URL=${shellQuote(link.hostUrl)}`);
  console.log(
    `export NYLORUN_SERVER_KEY=${shellQuote(credentials.applicationKey)}`,
  );
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
