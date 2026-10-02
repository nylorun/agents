/**
 * G2 — Hostile environment (§23 verbatim list).
 */
import { chmodSync, existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import {
  CLOUD_CREDENTIAL_MARKER,
  HOSTILE_MODEL_KEY,
  HOSTILE_OPENAI_KEY,
  HOSTILE_SANDBOX,
  HOSTILE_VAULT_KEK,
  applyHostileEnv,
  getJson,
  readTenantLog,
  startSecurityHost,
  writeEvilJs,
} from "./support.js";

const fixtureDir = dirname(
  fileURLToPath(new URL("../fixtures/stdio-env-dump-server.mjs", import.meta.url)),
);

it("G2: hostile env does not influence vault, model, sandbox, or HOME layout", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "sec-g2-"));
  const evil = await writeEvilJs(scratch);
  const restore = applyHostileEnv(evil.path);

  const host = await startSecurityHost({
    useHostileBaseline: true,
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
      headers: a.headers(),
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
      headers: a.headers(),
    });
    expect(model.status).toBe(200);
    expect(model.raw).not.toContain(HOSTILE_MODEL_KEY);
    expect(model.raw).not.toContain(HOSTILE_OPENAI_KEY);
    expect(model.raw).not.toContain("sk-tenant-owned-seed-key");

    const sandbox = await getJson(`${host.url}/v1/tenant/sandbox`, {
      headers: a.headers(),
    });
    expect(sandbox.status).toBe(200);
    // The backend selection must ignore NYLORUN_SANDBOX. The Tenant's own configuration
    // (`config`, whose unset default is also the word "none") is not part of the selection.
    const { config: _config, ...selection } = sandbox.body as Record<string, unknown>;
    expect(JSON.stringify(selection)).not.toContain(`"${HOSTILE_SANDBOX}"`);

    const status = await getJson(`${host.url}/v1/tenant`, {
      headers: a.headers(),
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

it("G2: stdio MCP child env excludes hostile values and uses Tenant HOME", async () => {
  chmodSync(join(fixtureDir, "stdio-env-dump-server.mjs"), 0o755);
  const scratch = await mkdtemp(join(tmpdir(), "sec-mcp-"));
  const evil = await writeEvilJs(scratch);
  const restore = applyHostileEnv(evil.path);
  const prompts: unknown[] = [];

  const host = await startSecurityHost({
    useHostileBaseline: true,
    sandboxBackend: "virtual",
    modelProvider: async (effect: { input: unknown }) => {
      const call = effect.input as {
        tools?: { name: string }[];
        prompt?: { kind?: string }[];
      };
      prompts.push(effect.input);
      if (call.prompt?.at(-1)?.kind === "tool-result")
        return { output: [{ type: "text", text: "done" }] };
      if ((call.tools ?? []).some((t) => t.name === "envdump__dump")) {
        return {
          output: [
            {
              type: "tool-call",
              id: "call-dump",
              name: "envdump__dump",
              args: {},
            },
          ],
        };
      }
      return { output: [{ type: "text", text: "done" }] };
    },
  });

  try {
    const a = host.tenant;
    const agent = Agent({ id: "bot", name: "Bot" })
      .use({
        id: "envdump",
        mcpServers: {
          envdump: {
            name: "envdump",
            type: "stdio",
            command: "./stdio-env-dump-server.mjs",
          },
        },
      })
      .build();

    const put = await getJson(`${host.url}/v1/agents/bot`, {
      method: "PUT",
      headers: a.headers(),
      body: JSON.stringify({
        requestId: "put-agent",
        manifest: agent.manifest,
        implementationVersion: "dev",
        pluginRoots: { envdump: fixtureDir },
      }),
    });
    expect(put.status).toBe(200);

    expect(
      (
        await getJson(`${host.url}/v1/sessions/s-hostile`, {
          method: "PUT",
          headers: a.headers(),
          body: JSON.stringify({
            requestId: "session-hostile",
            agentId: "bot",
            ownerUserId: "ada",
          }),
        })
      ).status,
    ).toBe(200);

    await getJson(`${host.url}/v1/sessions/s-hostile/commands`, {
      method: "POST",
      headers: a.headers(),
      body: JSON.stringify({
        type: "message",
        requestId: "msg-1",
        idempotencyKey: "msg-1",
        content: "env",
      }),
    });

    let body: { status?: string } = {};
    for (let i = 0; i < 200; i++) {
      const view = await getJson(`${host.url}/v1/sessions/s-hostile`, {
        headers: a.headers(),
      });
      body = view.body as { status?: string };
      if (body.status === "completed" || body.status === "failed") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(body.status).toBe("completed");

    const rendered = JSON.stringify(prompts);
    expect(rendered).toContain(a.paths.home);
    expect(rendered).not.toContain(HOSTILE_VAULT_KEK);
    expect(rendered).not.toContain(HOSTILE_MODEL_KEY);
    expect(rendered).not.toContain(HOSTILE_OPENAI_KEY);
    expect(rendered).not.toContain(HOSTILE_SANDBOX);
    expect(rendered).not.toContain("evil.js");
    expect(rendered).not.toContain(CLOUD_CREDENTIAL_MARKER);
    expect(rendered).not.toContain(host.ambientHome);
    expect(existsSync(evil.markerPath)).toBe(false);

    const tenantLog = readTenantLog(a);
    expect(tenantLog).not.toContain(HOSTILE_VAULT_KEK);
    expect(tenantLog).not.toContain(a.applicationKey);
  } finally {
    restore();
    await host.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
