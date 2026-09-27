import { expect, it } from "vitest";
import { writeFile, access } from "node:fs/promises";
import { join } from "node:path";
import {
  adminHeaders,
  createFakeModule,
  getJson,
  startTestHost,
} from "./support.js";

it("C6: admin shutdown stops accepting and removes host-state.json", async () => {
  const module = createFakeModule();
  const { url, host, root } = await startTestHost({ module });
  const statePath = join(root, "host-state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      version: "0.9.0-beta",
      entry: "test",
      url,
    }),
  );

  const shutdown = await getJson(`${url}/v1/admin/host/shutdown`, {
    method: "POST",
    headers: adminHeaders(),
  });
  expect(shutdown.status).toBe(200);

  // Allow close to finish.
  await new Promise((r) => setTimeout(r, 50));
  await host.close();

  await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(getJson(`${url}/health`)).rejects.toThrow();
});

it("admin shutdown stops the Worker, closes the Tenants, then the infrastructure, and settles closed", async () => {
  const steps: string[] = [];
  const base = createFakeModule();
  const module = {
    ...base,
    async close() {
      steps.push("tenants");
      await base.close();
    },
  };
  const { url, host } = await startTestHost({
    module,
    shutdown: {
      beforeTenants: async () => void steps.push("worker"),
      afterTenants: async () => void steps.push("infra"),
    },
  });
  const shutdown = await getJson(`${url}/v1/admin/host/shutdown`, {
    method: "POST",
    headers: adminHeaders(),
  });
  expect(shutdown.status).toBe(200);
  await host.closed;
  expect(steps).toEqual(["worker", "tenants", "infra"]);
  // A second close (SIGTERM after the route) runs nothing again.
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

it("C6: close() removes host-state.json", async () => {
  const { host, root, url } = await startTestHost();
  const statePath = join(root, "host-state.json");
  await writeFile(
    statePath,
    JSON.stringify({
      pid: 1,
      startedAt: new Date().toISOString(),
      version: "0.9.0-beta",
      entry: "test",
      url,
    }),
  );
  await host.close();
  await expect(access(statePath)).rejects.toMatchObject({ code: "ENOENT" });
});
