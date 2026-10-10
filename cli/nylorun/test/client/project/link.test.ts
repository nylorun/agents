import { chmod, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCredentials, readLink } from "../../../src/client/project/connection.js";
import { CliError } from "../../../src/errors.js";
import { HOST_ID, project, writeProjectLink } from "../helpers/project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await project("nylorun-link-");
  roots.push(root);
  return root;
}

it("reads a format 3 link: its Tenant, Host and the Tenant id as information", async () => {
  const root = await fixture();
  await writeProjectLink(root, {
    format: 3,
    tenant: "demo",
    hostUrl: "http://127.0.0.1:8787/",
    hostId: HOST_ID,
    tenantId: "tn_00000000000000000000000000",
  });
  expect(await readLink(root)).toEqual({
    format: 3,
    tenant: "demo",
    hostUrl: "http://127.0.0.1:8787",
    hostId: HOST_ID,
    tenantId: "tn_00000000000000000000000000",
  });
});

it("reads a format 3 link without a Tenant name or id", async () => {
  const root = await fixture();
  await writeProjectLink(root, {
    format: 3,
    hostUrl: "https://runtime.example.com",
    hostId: HOST_ID,
  });
  expect(await readLink(root)).toEqual({
    format: 3,
    hostUrl: "https://runtime.example.com",
    hostId: HOST_ID,
  });
});

it("refuses a link from an older nylorun (format 0 to 2)", async () => {
  for (const format of [undefined, 0, 1, 2]) {
    const root = await fixture();
    await writeProjectLink(root, {
      ...(format === undefined ? {} : { format }),
      ...(format === 2 ? { stack: "demo" } : {}),
      hostUrl: "http://127.0.0.1:8787",
      hostId: HOST_ID,
      tenantId: "tn_00000000000000000000000000",
    });
    const error = await readLink(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toBe(
      `The Project link at ${join(root, ".nylorun", "link.json")} is from an older nylorun. Run "npx nylorun start" in this project to link it again.`,
    );
  }
});

it("refuses a newer link format and an invalid link", async () => {
  const root = await fixture();
  await writeProjectLink(root, { format: 4, hostUrl: "http://x", hostId: HOST_ID });
  await expect(readLink(root)).rejects.toThrow("unsupported format");
  await writeProjectLink(root, { format: 3, hostId: HOST_ID });
  await expect(readLink(root)).rejects.toThrow("npx nylorun start");
});

it("no link is no link", async () => {
  expect(await readLink(await fixture())).toBeUndefined();
});

it("reads format 0 credentials, ignoring a legacy executors map, and keeps them 0600", async () => {
  const root = await fixture();
  await writeProjectLink(
    root,
    { format: 3, hostUrl: "http://127.0.0.1:8787", hostId: HOST_ID },
    {
      applicationKey: "b".repeat(64),
      principalId: "principal_legacy",
      executors: { agent: "c".repeat(64) },
    },
  );
  const path = join(root, ".nylorun/credentials.json");
  await chmod(path, 0o644);
  const credentials = await readCredentials(root);
  expect(credentials).toEqual({
    format: 0,
    applicationKey: "b".repeat(64),
    principalId: "principal_legacy",
  });
  expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("refuses invalid credentials, pointing at nylorun start", async () => {
  const root = await fixture();
  await writeProjectLink(
    root,
    { format: 3, hostUrl: "http://127.0.0.1:8787", hostId: HOST_ID },
    { format: 1, applicationKey: "short", principalId: "project" },
  );
  await expect(readCredentials(root)).rejects.toThrow('run "npx nylorun start"');
});
