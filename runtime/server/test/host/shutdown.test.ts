/**
 * Shutdown: `close()`, which SIGTERM calls (`host/main.ts`). There is no shutdown route since
 * the Admin API went (protocol 8).
 */
import { expect, it } from "vitest";
import { createFakeModule, getJson, startTestHost } from "./support.js";

it("C6: close stops accepting", async () => {
  const module = createFakeModule();
  const { url, host } = await startTestHost({ module });
  expect((await getJson(`${url}/health`)).status).toBe(200);
  await host.close();
  await expect(getJson(`${url}/health`)).rejects.toThrow();
});

it("close stops the Worker, closes the Tenants, then the infrastructure, and settles closed", async () => {
  const steps: string[] = [];
  const base = createFakeModule();
  const module = {
    ...base,
    async close() {
      steps.push("tenants");
      await base.close();
    },
  };
  const { host } = await startTestHost({
    module,
    shutdown: {
      beforeTenants: async () => void steps.push("worker"),
      afterTenants: async () => void steps.push("infra"),
    },
  });
  void host.close();
  await host.closed;
  expect(steps).toEqual(["worker", "tenants", "infra"]);
  // A second close (SIGTERM, then SIGINT) runs nothing again.
  await host.close();
  expect(steps).toEqual(["worker", "tenants", "infra"]);
});

it("close() goes on when a shutdown step fails", async () => {
  const steps: string[] = [];
  const logLines: string[] = [];
  const { host } = await startTestHost({
    logLines,
    shutdown: {
      beforeTenants: async () => {
        throw new Error("worker stop failed");
      },
      afterTenants: async () => void steps.push("infra"),
    },
  });
  await host.close();
  await host.closed;
  expect(steps).toEqual(["infra"]);
  expect(logLines.join("\n")).toMatch(/host_shutdown_step_failed/);
});
