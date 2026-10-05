import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const HOST_ID = "host_01habcdefghijklmnopqrstuvw";
export const APPLICATION_KEY = "ab".repeat(32);
export const MANAGEMENT_KEY = "cd".repeat(32);

/** A temporary Project directory (with package.json); the caller removes it. */
export async function project(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  await writeFile(join(root, "package.json"), '{"type":"module"}');
  return root;
}

/** Write `.nylorun/link.json` and `credentials.json` the way `nylorun start` does. */
export async function writeProjectLink(
  root: string,
  link: Record<string, unknown>,
  credentials: Record<string, unknown> | undefined = {
    format: 1,
    applicationKey: APPLICATION_KEY,
    principalId: "project",
    managementKey: MANAGEMENT_KEY,
    managementPrincipalId: "project-management",
  },
): Promise<void> {
  const dir = join(root, ".nylorun");
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".gitignore"), "*\n", { mode: 0o600 });
  await writeFile(join(dir, "link.json"), `${JSON.stringify(link, null, 2)}\n`, { mode: 0o600 });
  if (credentials)
    await writeFile(join(dir, "credentials.json"), `${JSON.stringify(credentials, null, 2)}\n`, {
      mode: 0o600,
    });
}

/** A format-3 link to `hostUrl` on the local Tenant `demo`. */
export const link3 = (hostUrl: string, extra: Record<string, unknown> = {}) => ({
  format: 3,
  tenant: "demo",
  hostUrl,
  hostId: HOST_ID,
  tenantId: "tn_00000000000000000000000000",
  ...extra,
});
