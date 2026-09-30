import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { createAdmin } from "../src/index.js";
import { ADMIN_KEY, healthBody, startStubServer } from "./helpers.js";

afterEach(() => {
  delete process.env.NYLORUN_ADMIN_URL;
  delete process.env.NYLORUN_ADMIN_KEY;
});

describe("B3 /health compatibility cache", () => {
  it("checks /health once, caches it, and sends Authorization and Nylorun-Protocol", async () => {
    let health = 0;
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        health += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await admin.listTenants();
      await admin.listTenants();
      expect(health).toBe(1);
      expect(server.recorded.filter((r) => r.url === "/health")).toHaveLength(
        1,
      );
      const authenticated = server.recorded.filter((r) =>
        r.url?.startsWith("/v1/"),
      );
      expect(authenticated.length).toBeGreaterThanOrEqual(2);
      for (const call of authenticated) {
        expect(call.headers.authorization).toBe(`Bearer ${ADMIN_KEY}`);
        expect(call.headers["nylorun-protocol"]).toBe(String(PROTOCOL_VERSION));
      }
    } finally {
      await server.close();
    }
  });

  it("throws incompatible_host when required features are missing", async () => {
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            healthBody({
              protocol: { min: 2, max: 2, features: [] },
            }),
          ),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.listTenants()).rejects.toMatchObject({
        code: "incompatible_host",
      });
      expect(server.recorded.map((r) => r.url)).toEqual(["/health"]);
    } finally {
      await server.close();
    }
  });

  it("clears the cache on 426 and rechecks once", async () => {
    let health = 0;
    let tenants = 0;
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        health += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify(
            health === 1
              ? healthBody()
              : healthBody({
                  protocol: {
                    min: 9,
                    max: 9,
                    features: [...PROTOCOL_FEATURES],
                  },
                }),
          ),
        );
        return;
      }
      tenants += 1;
      if (tenants === 1) {
        response.writeHead(426, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "rejected",
            code: "protocol_unsupported",
            message: "upgrade",
            protocol: { min: 9, max: 9, features: [...PROTOCOL_FEATURES] },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.listTenants()).rejects.toMatchObject({
        code: "incompatible_host",
      });
      expect(health).toBe(2);
      expect(tenants).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retries the request once when a 426 recheck still reports compatible", async () => {
    let health = 0;
    let tenants = 0;
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        health += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      tenants += 1;
      if (tenants === 1) {
        response.writeHead(426, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "rejected",
            code: "protocol_unsupported",
            message: "transient",
            protocol: { ...HOST_PROTOCOL, features: [...PROTOCOL_FEATURES] },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([]));
    });
    try {
      const admin = createAdmin({ url: server.url, key: ADMIN_KEY });
      await expect(admin.listTenants()).resolves.toEqual([]);
      expect(health).toBe(2);
      expect(tenants).toBe(2);
    } finally {
      await server.close();
    }
  });
});
