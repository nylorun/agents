/**
 * Acting for a subject: which credentials may send `Nylorun-Subject` and `Nylorun-Scopes`,
 * and what malformed headers answer. Validation runs only after authentication, so an
 * unknown credential sees the opaque 404 whatever headers it sends.
 */
import { request as httpRequest } from "node:http";
import { afterEach, beforeEach, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { APP, startSubjectTenant, type SubjectTenant } from "./subjects.js";

let tenant: SubjectTenant;
beforeEach(async () => {
  tenant = await startSubjectTenant();
});
afterEach(async () => {
  await tenant.close();
});

const member = { subject: "app:42", scopes: ["agents:read"] } as const;

it("advertises subject-headers", () => {
  expect(HOST_PROTOCOL.features).toContain("subject-headers");
});

it("acts for a subject only from an application principal", async () => {
  expect((await tenant.call("GET", "/v1/agents", { as: member })).status).toBe(200);
});

it("rejects missing, empty or unknown scopes and invalid subjects with 400", async () => {
  const cases: Record<string, string>[] = [
    { "Nylorun-Subject": "app:42" },
    { "Nylorun-Subject": "app:42", "Nylorun-Scopes": "" },
    { "Nylorun-Subject": "app:42", "Nylorun-Scopes": "sessions:all" },
    { "Nylorun-Subject": "app:42", "Nylorun-Scopes": "sessions:own admin" },
    { "Nylorun-Subject": "host", "Nylorun-Scopes": "sessions:own" },
    { "Nylorun-Subject": "x".repeat(201), "Nylorun-Scopes": "agents:read" },
    { "Nylorun-Subject": "ünïcode", "Nylorun-Scopes": "agents:read" },
    { "Nylorun-Scopes": "agents:read" },
  ];
  for (const headers of cases) {
    const reply = await tenant.call("GET", "/v1/agents", { headers });
    expect(reply.status, JSON.stringify(headers)).toBe(400);
    expect(reply.body.code).toBe("subject_invalid");
  }
  const longest = await tenant.call("GET", "/v1/agents", {
    as: { subject: "x".repeat(200), scopes: ["agents:read"] },
  });
  expect(longest.status).toBe(200);
});

it("rejects a subject header sent twice", async () => {
  const url = new URL(`${tenant.runtime.url}/v1/agents`);
  const status = await new Promise<number>((resolve, reject) => {
    const req = httpRequest(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: "GET",
        headers: [
          "authorization",
          `Bearer ${APP}`,
          "nylorun-subject",
          "app:1",
          "nylorun-subject",
          "app:2",
          "nylorun-scopes",
          "agents:read",
        ],
      },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      }
    );
    req.on("error", reject);
    req.end();
  });
  expect(status).toBe(400);
});

it("answers an unknown credential with the same opaque 404, with or without the headers", async () => {
  const plain = await tenant.call("GET", "/v1/sessions", { key: "not-a-key" });
  const withHeaders = await tenant.call("GET", "/v1/sessions", {
    key: "not-a-key",
    as: { subject: "app:42", scopes: "not-a-scope" },
  });
  expect(plain.status).toBe(404);
  expect(withHeaders.status).toBe(404);
  expect(withHeaders.text).toBe(plain.text);
});

it("leaves requests without Nylorun-Subject unchanged", async () => {
  const sessions = await tenant.call("GET", "/v1/sessions");
  expect(sessions.status).toBe(200);
  expect((await tenant.call("GET", "/v1/agents")).status).toBe(200);
});
