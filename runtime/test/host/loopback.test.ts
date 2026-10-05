import { request as httpRequest } from "node:http";
import { expect, it } from "vitest";
import { ERROR_CODES } from "@nylorun/core/compatibility";
import { RejectedResponseSchema } from "@nylorun/core/contracts";
import {
  createFakeModule,
  getJson,
  startTestHost,
  tenantHeaders,
} from "./support.js";

async function rawRequest(
  url: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  } = {},
): Promise<{ status: number; body: unknown; headerNames: string[] }> {
  const target = new URL(url);
  const payload = options.body;
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(options.headers ?? {}) };
    if (payload !== undefined && headers["content-length"] === undefined) {
      headers["content-length"] = String(Buffer.byteLength(payload));
    }
    const r = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: options.method ?? "GET",
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(Buffer.from(c)));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          let body: unknown = text;
          try {
            body = text ? JSON.parse(text) : undefined;
          } catch {
            /* keep text */
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            headerNames: Object.keys(res.headers).map((h) => h.toLowerCase()),
          });
        });
      },
    );
    r.on("error", reject);
    if (payload !== undefined) r.write(payload);
    r.end();
  });
}

function assertRejected(
  status: number,
  body: unknown,
  code: (typeof ERROR_CODES)[number],
  httpStatus: number,
): void {
  expect(status).toBe(httpStatus);
  const parsed = RejectedResponseSchema.parse(body);
  expect(parsed.status).toBe("rejected");
  expect(parsed.code).toBe(code);
  expect(ERROR_CODES).toContain(parsed.code);
}

it("A3: Host 127.0.0.1 / localhost / [::1] with listening port are accepted", async () => {
  const { url } = await startTestHost();
  const port = new URL(url).port;
  for (const host of [
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]) {
    const res = await rawRequest(`${url}/health`, {
      headers: { host },
    });
    expect(res.status, host).toBe(200);
  }
});

it("A3: foreign Host is 421 host_rejected on every route including /health", async () => {
  const module = createFakeModule();
  const { url } = await startTestHost({ module });
  const port = new URL(url).port;
  const routes = [
    "/health",
    "/ready",
    `/v1/agents`,
  ] as const;
  for (const path of routes) {
    const headers: Record<string, string> = {
      host: `evil.example:${port}`,
    };
    if (path.startsWith("/v1/")) {
      Object.assign(headers, tenantHeaders());
      headers.host = `evil.example:${port}`;
    }
    const res = await rawRequest(`${url}${path}`, { headers });
    assertRejected(res.status, res.body, "host_rejected", 421);
  }
});

it("A3: wrong port in Host is rejected; non-configured host rejected with allowNonLoopback", async () => {
  const { url } = await startTestHost();
  const port = Number(new URL(url).port);
  const wrong = await rawRequest(`${url}/health`, {
    headers: { host: `127.0.0.1:${port + 1}` },
  });
  assertRejected(wrong.status, wrong.body, "host_rejected", 421);

  const allowed = await startTestHost({
    host: "127.0.0.1",
    allowNonLoopback: true,
  });
  const allowedPort = new URL(allowed.url).port;
  const ok = await rawRequest(`${allowed.url}/health`, {
    headers: { host: `127.0.0.1:${allowedPort}` },
  });
  expect(ok.status).toBe(200);

  const foreign = await rawRequest(`${allowed.url}/health`, {
    headers: { host: `192.0.2.1:${allowedPort}` },
  });
  assertRejected(foreign.status, foreign.body, "host_rejected", 421);
});

it("A4: any Origin header yields 403 origin_rejected; no Access-Control-* headers", async () => {
  const { url } = await startTestHost();
  const port = new URL(url).port;
  for (const origin of ["http://localhost:3000", "null", ""]) {
    const res = await rawRequest(`${url}/health`, {
      headers: {
        host: `127.0.0.1:${port}`,
        origin,
      },
    });
    assertRejected(res.status, res.body, "origin_rejected", 403);
    expect(res.headerNames.some((h) => h.startsWith("access-control-"))).toBe(
      false,
    );
  }

  const ok = await getJson(`${url}/health`);
  expect(ok.status).toBe(200);
  const cors = [...ok.headers.keys()].filter((h) =>
    h.toLowerCase().startsWith("access-control-"),
  );
  expect(cors).toEqual([]);
});

it("A5: body with non-application/json content type is 415", async () => {
  const { url } = await startTestHost();
  const port = new URL(url).port;
  const res = await rawRequest(`${url}/v1/agents`, {
    method: "POST",
    headers: {
      ...tenantHeaders(),
      host: `127.0.0.1:${port}`,
      "content-type": "text/plain",
    },
    body: '{"name":"x"}',
  });
  assertRejected(res.status, res.body, "unsupported_media_type", 415);

  const charset = await rawRequest(`${url}/v1/agents`, {
    method: "POST",
    headers: {
      ...tenantHeaders(),
      host: `127.0.0.1:${port}`,
      "content-type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ name: "n" }),
  });
  expect(charset.status).toBe(200);
});

it("A6: security rejections match RejectedResponseSchema and ERROR_CODES", async () => {
  const { url } = await startTestHost();
  const port = new URL(url).port;
  const cases: Array<{
    headers: Record<string, string>;
    method?: string;
    body?: string;
    code: (typeof ERROR_CODES)[number];
    status: number;
  }> = [
    {
      headers: { host: `rebinder.test:${port}` },
      code: "host_rejected",
      status: 421,
    },
    {
      headers: {
        host: `127.0.0.1:${port}`,
        origin: "https://evil.test",
      },
      code: "origin_rejected",
      status: 403,
    },
    {
      headers: {
        host: `127.0.0.1:${port}`,
        "content-type": "application/xml",
      },
      method: "POST",
      body: "<x/>",
      code: "unsupported_media_type",
      status: 415,
    },
  ];
  for (const c of cases) {
    const res = await rawRequest(`${url}/health`, {
      method: c.method ?? "GET",
      headers: c.headers,
      body: c.body,
    });
    assertRejected(res.status, res.body, c.code, c.status);
  }
});
