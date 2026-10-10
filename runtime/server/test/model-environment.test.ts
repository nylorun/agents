import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { modelsFor } from "../src/model/models.js";
import { ProjectCredentialStore } from "../src/model/auth-store.js";
import { projectSecrets } from "../src/model/settings.js";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "model-env-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

it("resolves credentials from the explicit store only", async () => {
  const root = await fixture();
  const store = new ProjectCredentialStore(join(root, ".nylorun", "auth.json"));
  await store.modify("openai", async () => ({
    type: "api_key",
    key: "stored-key",
  }));
  const registry = modelsFor({ provider: "openai", model: "unused" }, store);
  expect((await registry.getAuth("openai"))?.auth.apiKey).toBe("stored-key");
});

it("rejects ambient environment credential mode", () => {
  const store = new ProjectCredentialStore("/tmp/unused-auth.json");
  expect(() =>
    modelsFor({ provider: "openai", model: "unused" }, store, {
      environment: true,
    }),
  ).toThrow(/Ambient model environment is not supported/);
});

it("reads legacy OAuth state and includes credentials in redaction from an explicit env map", async () => {
  const root = await fixture();
  await mkdir(join(root, ".env"));
  const credential = {
    type: "oauth",
    access: "access-secret",
    refresh: "refresh-secret",
    expires: 9999999999999,
  };
  await writeFile(
    join(root, ".env", "auth.json"),
    JSON.stringify({ fixture: credential }),
  );
  const store = new ProjectCredentialStore(
    join(root, ".nylorun", "auth.json"),
    join(root, ".env", "auth.json"),
  );
  expect(await store.read("fixture")).toEqual(credential);
  await store.modify("fixture", async () => ({
    ...credential,
    type: "oauth",
    access: "new-secret",
  }));
  expect(
    projectSecrets(root, { MODEL_PROVIDER_API_KEY: "explicit-secret" }),
  ).toEqual(
    expect.arrayContaining([
      "explicit-secret",
      "new-secret",
      "refresh-secret",
      "access-secret",
    ]),
  );
});
