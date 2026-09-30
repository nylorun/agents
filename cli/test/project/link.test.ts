import {
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
  ensureProjectNylorunDir,
  readLink,
  writeLink,
  removeLink,
} from "../../src/project/link.js";
import {
  readCredentials,
  writeCredentials,
} from "../../src/project/credentials.js";
import { newTenantId } from "@nylorun/agents";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "nylorun-link-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"demo"}');
  return root;
}

it("creates .nylorun 0700 with private .gitignore containing *", async () => {
  const root = await fixture();
  const dir = await ensureProjectNylorunDir(root);
  expect(dir).toBe(join(root, ".nylorun"));
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("*\n");
  await expect(readFile(join(root, ".gitignore"))).rejects.toThrow();
});

it("F2-2: writes format 1 link.json and credentials.json without executors", async () => {
  const root = await fixture();
  const tenantId = newTenantId();
  await writeLink(root, {
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuv",
    tenantId,
  });
  await writeCredentials(root, {
    applicationKey: "a".repeat(64),
    principalId: "pr_testprincipal00000000000001",
  });
  expect((await stat(join(root, ".nylorun/link.json"))).mode & 0o777).toBe(
    0o600,
  );
  expect(
    (await stat(join(root, ".nylorun/credentials.json"))).mode & 0o777,
  ).toBe(0o600);
  const linkRaw = JSON.parse(
    await readFile(join(root, ".nylorun/link.json"), "utf8"),
  );
  expect(linkRaw).toEqual({
    format: 1,
    hostUrl: "http://127.0.0.1:8787",
    hostId: "host_01habcdefghijklmnopqrstuv",
    tenantId,
  });
  const credRaw = JSON.parse(
    await readFile(join(root, ".nylorun/credentials.json"), "utf8"),
  );
  expect(credRaw).toEqual({
    format: 1,
    applicationKey: "a".repeat(64),
    principalId: "pr_testprincipal00000000000001",
  });
  expect(credRaw).not.toHaveProperty("executors");
  expect(await readLink(root)).toMatchObject({ format: 1, tenantId });
  expect(await readCredentials(root)).toMatchObject({ format: 1 });
  await removeLink(root);
  expect(await readLink(root)).toBeUndefined();
});

it("F2-2: reads format 0 link and credentials, ignoring a legacy executors map", async () => {
  const root = await fixture();
  const tenantId = newTenantId();
  await ensureProjectNylorunDir(root);
  await writeFile(
    join(root, ".nylorun/link.json"),
    JSON.stringify({
      hostUrl: "http://127.0.0.1:8787",
      hostId: "host_01habcdefghijklmnopqrstuv",
      tenantId,
    }),
  );
  await writeFile(
    join(root, ".nylorun/credentials.json"),
    JSON.stringify({
      applicationKey: "b".repeat(64),
      principalId: "principal_legacy",
      executors: { agent: "c".repeat(64) },
    }),
  );
  const link = await readLink(root);
  const credentials = await readCredentials(root);
  expect(link?.format).toBe(0);
  expect(credentials?.format).toBe(0);
  expect(credentials).not.toHaveProperty("executors");
  await writeCredentials(root, {
    applicationKey: credentials!.applicationKey,
    principalId: credentials!.principalId,
  });
  const rewritten = JSON.parse(
    await readFile(join(root, ".nylorun/credentials.json"), "utf8"),
  );
  expect(rewritten.format).toBe(1);
  expect(rewritten).not.toHaveProperty("executors");
});
