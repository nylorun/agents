import { createServer } from "node:http";
import { afterEach, expect, it } from "vitest";
import {
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { doctorSandbox, sandboxBanner } from "../src/doctor.js";

const servers: { close(): void }[] = [];
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
    expect(request.headers.authorization).toBe("Bearer key");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(report));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  return `http://127.0.0.1:${address.port}`;
}

const manifest = (sandbox?: Record<string, unknown>) =>
  ({
    manifestSchemaVersion: 4,
    id: "analyst",
    capabilities: [
      { id: "sandbox", type: "agent", ...(sandbox ? { sandbox } : {}) },
    ],
  }) as never;

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

it("says nothing when no agent declares a sandbox", async () => {
  expect(
    await sandboxBanner("http://127.0.0.1:9", "key", [manifest()], "tn_test"),
  ).toBeUndefined();
});

it("F2-4: names the backend and network from Tenant sandbox", async () => {
  const url = await runtime(report);
  expect(
    await sandboxBanner(
      url,
      "key",
      [manifest({ network: { preset: "none" } })],
      "tn_test",
    ),
  ).toBe("sandbox: virtual shell · network: none");
});

it("names the reason and the fix when no backend is available", async () => {
  const url = await runtime({
    preference: "auto",
    backend: null,
    isolation: null,
    reason: "no sandbox backend is available (virtual: could not load just-bash)",
    probes: [{ ...probes[0], available: false }],
  });
  expect(await sandboxBanner(url, "key", [manifest({})], "tn_test")).toBe(
    "sandbox: unavailable (no sandbox backend is available (virtual: could not load just-bash)) · run `npx nylorun doctor sandbox` for options",
  );
});

it("F2-4: doctor sandbox prints Tenant API report (snapshot)", async () => {
  const url = await runtime(report);
  const previous = {
    url: process.env.NYLORUN_RUNTIME_URL,
    tenant: process.env.NYLORUN_TENANT,
    key: process.env.NYLORUN_SERVER_KEY,
  };
  process.env.NYLORUN_RUNTIME_URL = url;
  process.env.NYLORUN_TENANT = "tn_test";
  process.env.NYLORUN_SERVER_KEY = "key";
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
    if (previous.tenant === undefined) delete process.env.NYLORUN_TENANT;
    else process.env.NYLORUN_TENANT = previous.tenant;
    if (previous.key === undefined) delete process.env.NYLORUN_SERVER_KEY;
    else process.env.NYLORUN_SERVER_KEY = previous.key;
  }
  const text = lines.join("\n");
  expect(text).toContain("virtual");
  expect(text).toContain("selected");
  expect(text).toContain("preference");
  expect(text).toMatch(/platform/);
});
