import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { doctorSandbox } from "../../src/client/doctor.js";

const servers: { close(): void }[] = [];
const tenantHeaders: (string | string[] | undefined)[] = [];
afterEach(() => servers.splice(0).forEach((server) => server.close()));

async function runtime(report: unknown): Promise<string> {
  const server = createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === "/health") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          status: "ok",
          protocol: {
            min: PROTOCOL_VERSION,
            max: PROTOCOL_VERSION,
            features: [...PROTOCOL_FEATURES],
          },
        }),
      );
      return;
    }
    // The Management API, with the management key.
    expect(url).toBe("/v1/tenant/sandbox");
    expect(request.headers.authorization).toBe("Bearer key");
    tenantHeaders.push(request.headers["nylorun-tenant"]);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(report));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

const probes = [
  {
    name: "virtual",
    isolation: "process",
    available: true,
    reason: "emulated shell in the Runtime process (not a VM)",
  },
];

const report = {
  preference: "auto",
  backend: "virtual",
  isolation: "process",
  reason: "emulated shell in the Runtime process (not a VM)",
  probes,
  defaultImage: "python:3.13-slim",
};

it("F2-4: doctor sandbox prints Tenant API report (snapshot)", async () => {
  const url = await runtime(report);
  const previous = {
    url: process.env.NYLORUN_RUNTIME_URL,
    key: process.env.NYLORUN_MANAGEMENT_KEY,
  };
  process.env.NYLORUN_RUNTIME_URL = url;
  process.env.NYLORUN_MANAGEMENT_KEY = "key";
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    await doctorSandbox({ json: false });
  } finally {
    console.log = original;
    if (previous.url === undefined) delete process.env.NYLORUN_RUNTIME_URL;
    else process.env.NYLORUN_RUNTIME_URL = previous.url;
    if (previous.key === undefined) delete process.env.NYLORUN_MANAGEMENT_KEY;
    else process.env.NYLORUN_MANAGEMENT_KEY = previous.key;
  }
  const text = lines.join("\n");
  expect(text).toContain("virtual");
  expect(text).toContain("selected");
  expect(text).toContain("preference");
  expect(text).toMatch(/platform/);
  // The report request names no Tenant: the installation serves one.
  expect(tenantHeaders).toEqual([undefined]);
});
