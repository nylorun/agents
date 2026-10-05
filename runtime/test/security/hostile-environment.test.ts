/**
 * G2 — Hostile environment (§23 verbatim list).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  HOSTILE_MODEL_KEY,
  HOSTILE_OPENAI_KEY,
  HOSTILE_SANDBOX,
  HOSTILE_VAULT_KEK,
  applyHostileEnv,
  getJson,
  startSecurityHost,
  writeEvilJs,
} from "./support.js";

it("G2: hostile env does not influence vault, model, sandbox, or HOME layout", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sec-g2-"));
  const evil = await writeEvilJs(scratch);
  const restore = applyHostileEnv(evil.path);

  const host = await startSecurityHost({
    sandboxBackend: "virtual",
    model: { kind: "scripted", output: "ok" },
  });

  try {
    expect(process.env.NYLORUN_VAULT_KEK).toBe(HOSTILE_VAULT_KEK);
    expect(process.env.MODEL_PROVIDER_API_KEY).toBe(HOSTILE_MODEL_KEY);
    expect(process.env.OPENAI_API_KEY).toBe(HOSTILE_OPENAI_KEY);
    expect(process.env.NYLORUN_SANDBOX).toBe(HOSTILE_SANDBOX);
    expect(process.env.NODE_OPTIONS).toContain("evil.js");

    const a = host.tenant;

    const kekFile = readFileSync(a.paths.kek, "utf8").trim();
    expect(kekFile).not.toBe(HOSTILE_VAULT_KEK);
    expect(kekFile.length).toBeGreaterThan(0);

    const seed = await getJson(`${host.url}/v1/tenant/config/seed`, {
      method: "PUT",
      headers: a.managementHeaders(),
      body: JSON.stringify({
        requestId: randomUUID(),
        sandbox: { backend: "virtual" },
        model: {
          provider: "openai",
          model: "gpt-4o-mini",
          auth: { type: "api_key", key: "sk-tenant-owned-seed-key" },
        },
      }),
    });
    expect(seed.status).toBe(200);

    const model = await getJson(`${host.url}/v1/tenant/model`, {
      headers: a.managementHeaders(),
    });
    expect(model.status).toBe(200);
    expect(model.raw).not.toContain(HOSTILE_MODEL_KEY);
    expect(model.raw).not.toContain(HOSTILE_OPENAI_KEY);
    expect(model.raw).not.toContain("sk-tenant-owned-seed-key");

    const sandbox = await getJson(`${host.url}/v1/tenant/sandbox`, {
      headers: a.managementHeaders(),
    });
    expect(sandbox.status).toBe(200);
    // The backend selection must ignore NYLORUN_SANDBOX. The Tenant's own configuration
    // (`config`, whose unset default is also the word "none") is not part of the selection.
    const { config: _config, ...selection } = sandbox.body as Record<string, unknown>;
    expect(JSON.stringify(selection)).not.toContain(`"${HOSTILE_SANDBOX}"`);

    const status = await getJson(`${host.url}/v1/tenant`, {
      headers: a.managementHeaders(),
    });
    expect(status.status).toBe(200);
    expect(status.raw).not.toContain(HOSTILE_VAULT_KEK);
    expect(status.raw).not.toContain(HOSTILE_MODEL_KEY);

    expect(a.paths.home.startsWith(host.hostRoot)).toBe(true);
    expect(existsSync(join(a.paths.home, ".aws", "credentials"))).toBe(false);
    expect(existsSync(join(host.hostRoot, "home", ".aws", "credentials"))).toBe(
      false,
    );
    expect(existsSync(join(host.ambientHome, ".aws", "credentials"))).toBe(
      true,
    );

    expect(a.paths.home).not.toBe(join(host.hostRoot, "home"));
    expect(existsSync(evil.markerPath)).toBe(false);
  } finally {
    restore();
    await host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
