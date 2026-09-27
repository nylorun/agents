import { readCredentials } from "./credentials.js";
import { readLink } from "./link.js";
import { findProjectRoot } from "./root.js";

/** Three `export` lines for `nylo env` (was `nylorun status --env`, F2-7). */
export async function printLinkedEnvExports(
  projectRoot = process.cwd(),
): Promise<void> {
  const root = findProjectRoot(projectRoot) ?? projectRoot;
  const link = await readLink(root);
  const credentials = await readCredentials(root);
  if (!link || !credentials) {
    console.log(
      "# No Project link in this directory. Run nylo tenant create to create one.",
    );
    return;
  }
  console.log(`export NYLORUN_RUNTIME_URL=${shellQuote(link.hostUrl)}`);
  console.log(
    `export NYLORUN_SERVER_KEY=${shellQuote(credentials.applicationKey)}`,
  );
  console.log(`export NYLORUN_TENANT=${shellQuote(link.tenantId)}`);
}

export function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
