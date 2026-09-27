/**
 * G3 — `.env` change after seeding leaves Tenant configuration unchanged.
 */
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  HOSTILE_MODEL_KEY,
  HOSTILE_OPENAI_KEY,
  HOSTILE_SANDBOX,
  applyHostileEnv,
  getJson,
  startSecurityHost,
  writeEvilJs,
} from "./support.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("G3: ambient/env changes after seed do not overwrite Tenant config", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sec-g3-"));
  const evil = await writeEvilJs(scratch);
  const host = await startSecurityHost({
    sandboxBackend: "virtual",
    model: { kind: "scripted", output: "ok" },
  });

  try {
    const [a] = host.tenants;
    const seed = await getJson(`${host.url}/v1/tenant/config/seed`, {
      method: "PUT",
      headers: a.headers(),
      body: JSON.stringify({
        requestId: randomUUID(),
        sandbox: { backend: "virtual" },
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          auth: { type: "api_key", key: "sk-seeded-before-env-change" },
        },
      }),
    });
    expect(seed.status).toBe(200);
    expect(seed.body).toMatchObject({
      applied: expect.arrayContaining(["model", "sandbox.backend"]),
    });

    const beforeModel = await getJson(`${host.url}/v1/tenant/model`, {
      headers: a.headers(),
    });
    const beforeSandbox = await getJson(`${host.url}/v1/tenant/sandbox`, {
      headers: a.headers(),
    });
    expect(beforeModel.status).toBe(200);
    expect(beforeSandbox.status).toBe(200);

    // Simulate a project `.env` reload that mutates ambient process env after seed.
    const restore = applyHostileEnv(evil.path);
    try {
      process.env.MODEL_PROVIDER_API_KEY = "sk-env-after-seed-should-not-apply";
      process.env.OPENAI_API_KEY = HOSTILE_OPENAI_KEY;
      process.env.NYLORUN_SANDBOX = HOSTILE_SANDBOX;

      const again = await getJson(`${host.url}/v1/tenant/config/seed`, {
        method: "PUT",
        headers: a.headers(),
        body: JSON.stringify({
          requestId: randomUUID(),
          sandbox: { backend: "auto" },
          model: {
            provider: "anthropic",
            model: "claude",
            auth: { type: "api_key", key: HOSTILE_MODEL_KEY },
          },
        }),
      });
      expect(again.status).toBe(200);
      expect(again.body).toMatchObject({
        applied: [],
        kept: expect.arrayContaining(["model", "sandbox.backend"]),
      });

      const afterModel = await getJson(`${host.url}/v1/tenant/model`, {
        headers: a.headers(),
      });
      const afterSandbox = await getJson(`${host.url}/v1/tenant/sandbox`, {
        headers: a.headers(),
      });
      expect(afterModel.raw).toBe(beforeModel.raw);
      expect(afterSandbox.raw).toBe(beforeSandbox.raw);
      expect(afterModel.raw).not.toContain(HOSTILE_MODEL_KEY);
      expect(afterModel.raw).not.toContain("sk-env-after-seed-should-not-apply");
    } finally {
      restore();
    }
  } finally {
    await host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
