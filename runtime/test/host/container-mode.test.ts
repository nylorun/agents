import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { freePort, startTestHost } from "./support.js";

function get(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: unknown }> {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const r = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            status: res.statusCode ?? 0,
            body: text ? JSON.parse(text) : undefined,
          });
        });
      },
    );
    r.on("error", reject);
    r.end();
  });
}

async function startContainerHost() {
  const listenPort = await freePort();
  // host.json describes the client-facing address (published port 8787 on a
  // non-loopback name here), which the container Host must not bind.
  const started = await startTestHost({
    host: "192.0.2.10",
    port: 8787,
    listen: {
      host: "127.0.0.1",
      port: listenPort,
      allowedHosts: [
        "runtime:4000",
        "localhost:8787",
        `127.0.0.1:${listenPort}`,
      ],
    },
  });
  return { ...started, listenPort };
}

it("container mode binds the listen override, not host.json's host and port", async () => {
  const { url, listenPort } = await startContainerHost();
  expect(url).toBe(`http://127.0.0.1:${listenPort}`);
  const res = await get(`${url}/health`, { host: `127.0.0.1:${listenPort}` });
  expect(res.status).toBe(200);
});

it("container mode accepts only the configured Host headers", async () => {
  const { url, listenPort } = await startContainerHost();
  for (const host of ["runtime:4000", "LOCALHOST:8787"]) {
    const res = await get(`${url}/health`, { host });
    expect(res.status, host).toBe(200);
  }
  for (const host of [
    `localhost:${listenPort}`,
    `[::1]:${listenPort}`,
    "127.0.0.1:8787",
    "runtime:8787",
    "rebinder.test:8787",
  ]) {
    const res = await get(`${url}/health`, { host });
    expect(res.status, host).toBe(421);
    expect((res.body as { code: string }).code).toBe("host_rejected");
  }
});

it("container mode keeps the Origin rule", async () => {
  const { url } = await startContainerHost();
  const res = await get(`${url}/health`, {
    host: "runtime:4000",
    origin: "http://localhost:4161",
  });
  expect(res.status).toBe(403);
  expect((res.body as { code: string }).code).toBe("origin_rejected");
});

it("local mode still refuses a non-loopback host.json host", async () => {
  await expect(
    startTestHost({ host: "192.0.2.10" }),
  ).rejects.toThrow(/Refusing to bind non-loopback host/);
});
