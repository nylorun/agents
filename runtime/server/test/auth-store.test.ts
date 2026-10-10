import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { ProjectCredentialStore } from "../src/model/auth-store.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function store() {
  const root = await mkdtemp(join(tmpdir(), "auth-store-"));
  roots.push(root);
  const file = join(root, ".env", "auth.json");
  return { store: new ProjectCredentialStore(file), file };
}

const apiKey = { type: "api_key" as const, key: "secret" };

it("modify leaves the entry unchanged when the callback returns undefined", async () => {
  const { store: credentials, file } = await store();
  await credentials.modify("fixture", async () => apiKey);
  // pi-ai's OAuth refresh returns undefined when another caller already refreshed.
  const result = await credentials.modify("fixture", async () => undefined);
  expect(result).toEqual(apiKey);
  expect(await credentials.read("fixture")).toEqual(apiKey);
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ fixture: apiKey });
});

it("delete removes only the named credential", async () => {
  const { store: credentials } = await store();
  await credentials.modify("fixture", async () => apiKey);
  await credentials.modify("other", async () => apiKey);
  await credentials.delete("fixture");
  await credentials.delete("missing");
  expect(await credentials.list()).toEqual([
    { providerId: "other", type: "api_key" },
  ]);
});
