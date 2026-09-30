/**
 * A session opened with a sandbox on an OpenShell Tenant, end to end: resolution allows an image,
 * the pinned tools name OpenShell's workspace, and the model's `bash` runs in the sandbox.
 * Skipped unless NYLORUN_TEST_OPENSHELL=1 (gateway: NYLORUN_TEST_OPENSHELL_GATEWAY).
 */
import { describe, expect, it } from "vitest";
import { Agent } from "@nylorun/core/define";
import { openshellBackend } from "../../src/adapters/sandbox/openshell/backend.js";
import { startTestTenant } from "../support/tenant.js";
import type { ModelProvider } from "../../src/core/provider.js";

const APP = "openshell-session-app-token-aaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };
const gateway = process.env.NYLORUN_TEST_OPENSHELL_GATEWAY ?? "http://127.0.0.1:8080";

const suite = process.env.NYLORUN_TEST_OPENSHELL === "1" ? describe : describe.skip;

suite("a session on an OpenShell sandbox", () => {
  it("runs the model's bash in OpenShell, with the tools naming /sandbox", { timeout: 300_000 }, async () => {
    const seen: { tools: { name: string; description?: string }[]; result?: unknown }[] = [];
    const model: ModelProvider = async (effect) => {
      const input = effect.input as {
        prompt?: { kind?: string; content?: unknown }[];
        tools?: { name: string; description?: string }[];
      };
      const results = (input.prompt ?? []).filter((item) => item.kind === "tool-result");
      seen.push({ tools: input.tools ?? [], result: results.at(-1) });
      if (results.length > 0) return { output: [{ type: "text", text: "done" }] };
      return {
        output: [
          {
            type: "tool-call",
            id: `call-${effect.turnId}`,
            name: "bash",
            args: { command: "pwd; id -un; (exec 3<>/dev/tcp/example.com/443) && echo reached || echo blocked" },
          },
        ],
      };
    };
    const runtime = await startTestTenant({
      mode: "test",
      applicationKey: APP,
      vaultKek: null,
      modelProvider: model,
      sandbox: { backend: "openshell", backends: [openshellBackend({ gateway })] },
    });
    try {
      const agent = Agent({ id: "bot", name: "Bot" }).instructions("Use the sandbox.").build();
      const put = await fetch(`${runtime.url}/v1/agents/bot`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ requestId: "put", manifest: agent.manifest, implementationVersion: "dev" }),
      });
      expect(put.ok, await put.clone().text()).toBe(true);
      const opened = await fetch(`${runtime.url}/v1/sessions/s1`, {
        method: "PUT",
        headers,
        body: JSON.stringify({
          requestId: "open",
          agentId: "bot",
          ownerUserId: "ada",
          sandbox: { image: "nvcr.io/nvidia/base/ubuntu:24.04", resources: { cpus: 1 } },
        }),
      });
      expect(opened.ok, await opened.clone().text()).toBe(true);
      await fetch(`${runtime.url}/v1/sessions/s1/commands`, {
        method: "POST",
        headers,
        body: JSON.stringify({ type: "message", requestId: "m1", idempotencyKey: "m1", content: "go" }),
      });
      let status = "";
      for (let attempt = 0; attempt < 600 && !["completed", "failed"].includes(status); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        status = ((await (await fetch(`${runtime.url}/v1/sessions/s1`, { headers })).json()) as { status: string })
          .status;
      }
      expect(status).toBe("completed");
      const bash = seen[0]!.tools.find((tool) => tool.name === "bash");
      expect(bash?.description).toContain("/sandbox");
      const result = JSON.stringify(seen.at(-1)!.result);
      expect(result).toContain("/sandbox");
      expect(result).toContain("blocked");
      expect(result).not.toContain("reached");
    } finally {
      await runtime.close();
      // Closing stops sandboxes; delete this Tenant's so the gateway stays clean.
      const backend = openshellBackend({ gateway });
      for (const key of await backend.list(`nylorun-${runtime.tenantId}-`)) await backend.remove(key);
    }
  });
});
