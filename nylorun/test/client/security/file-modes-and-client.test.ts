/**
 * Project credential modes, and the Tenant API client `nylo` builds: a URL and a key, with
 * nothing that selects a Tenant. Host layout checks moved with WS-F1 (host/ deleted).
 */
import { rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { PROTOCOL_FEATURES, PROTOCOL_VERSION } from "@nylorun/core/compatibility";
import { createClient } from "@nylorun/agents";
import { linkedConnection, readCredentials } from "../../../src/client/project/connection.js";
import { APPLICATION_KEY, link3, MANAGEMENT_KEY, project, writeProjectLink } from "../helpers/project.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("the linked client sends the key and the protocol, and no Nylorun-Tenant header", async () => {
  const root = await project("cli-sec-project-");
  roots.push(root);
  await writeProjectLink(root, link3("http://127.0.0.1:8787"));
  const connection = await linkedConnection(root, {});
  expect(connection).toMatchObject({
    url: "http://127.0.0.1:8787",
    key: APPLICATION_KEY,
    managementKey: MANAGEMENT_KEY,
  });
  const seen: Headers[] = [];
  const client = createClient({
    url: connection.url,
    key: connection.key,
    fetch: async (input, init) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return Response.json({
          status: "ok",
          protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION, features: [...PROTOCOL_FEATURES] },
        });
      seen.push(new Headers(init?.headers));
      return Response.json({ agents: [] });
    },
  });
  await client.transport.json("/v1/agents", "GET");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.get("authorization")).toBe(`Bearer ${APPLICATION_KEY}`);
  expect(seen[0]!.get("nylorun-protocol")).toBe(String(PROTOCOL_VERSION));
  expect(seen[0]!.has("nylorun-tenant")).toBe(false);
});

it("without a link, NYLORUN_RUNTIME_URL and NYLORUN_SERVER_KEY are the connection", async () => {
  const root = await project("cli-sec-project-");
  roots.push(root);
  expect(
    await linkedConnection(root, {
      NYLORUN_RUNTIME_URL: "https://runtime.example.com/",
      NYLORUN_SERVER_KEY: "key",
    }),
  ).toEqual({ url: "https://runtime.example.com", key: "key" });
  expect(
    await linkedConnection(root, {
      NYLORUN_RUNTIME_URL: "https://runtime.example.com",
      NYLORUN_MANAGEMENT_KEY: "management",
    }),
  ).toEqual({ url: "https://runtime.example.com", managementKey: "management" });
  await expect(linkedConnection(root, { NYLORUN_RUNTIME_URL: "https://x" })).rejects.toThrow(
    'Run "npx nylorun start" in this project',
  );
});

it("project credentials are read back 0600 inside a 0700 .nylorun", async () => {
  const root = await project("cli-sec-project-");
  roots.push(root);
  await writeProjectLink(root, link3("http://127.0.0.1:8787"));
  expect(await readCredentials(root)).toMatchObject({ applicationKey: APPLICATION_KEY });
  expect((await stat(join(root, ".nylorun"))).mode & 0o777).toBe(0o700);
  expect((await stat(join(root, ".nylorun/credentials.json"))).mode & 0o777).toBe(0o600);
});
