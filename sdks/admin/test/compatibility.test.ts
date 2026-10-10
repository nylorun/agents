import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_VERSION,
} from "@nylorun/core/compatibility";
import { createAdmin } from "../src/index.js";
import { MANAGEMENT_KEY, healthBody, sampleTenantStatus, startStubServer } from "./helpers.js";

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
      response.end(JSON.stringify(sampleTenantStatus()));
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await admin.tenant.status();
      await admin.tenant.status();
      expect(health).toBe(1);
      expect(server.recorded.filter((r) => r.url === "/health")).toHaveLength(
        1,
      );
      const authenticated = server.recorded.filter((r) =>
        r.url?.startsWith("/v1/"),
      );
      expect(authenticated.length).toBeGreaterThanOrEqual(2);
      for (const call of authenticated) {
        expect(call.headers.authorization).toBe(`Bearer ${MANAGEMENT_KEY}`);
        expect(call.headers["nylorun-protocol"]).toBe(String(PROTOCOL_VERSION));
      }
    } finally {
      await server.close();
    }
  });

  it("requires the management-api feature", async () => {
    const server = await startStubServer((request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          request.url === "/health"
            ? healthBody({
                protocol: {
                  ...HOST_PROTOCOL,
                  features: PROTOCOL_FEATURES.filter((feature) => feature !== "management-api"),
                },
              })
            : sampleTenantStatus(),
        ),
      );
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.keys.list()).rejects.toMatchObject({
        code: "incompatible_host",
        message: expect.stringContaining("management-api"),
      });
      expect(server.recorded.map((r) => r.url)).toEqual(["/health"]);
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
      response.end(JSON.stringify(sampleTenantStatus()));
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.tenant.status()).rejects.toMatchObject({
        code: "incompatible_host",
      });
      expect(server.recorded.map((r) => r.url)).toEqual(["/health"]);
    } finally {
      await server.close();
    }
  });

  it("clears the cache on 426 and rechecks once", async () => {
    let health = 0;
    let requests = 0;
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
                    min: 11,
                    max: 11,
                    features: [...PROTOCOL_FEATURES],
                  },
                }),
          ),
        );
        return;
      }
      requests += 1;
      if (requests === 1) {
        response.writeHead(426, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            status: "rejected",
            code: "protocol_unsupported",
            message: "upgrade",
            protocol: { min: 11, max: 11, features: [...PROTOCOL_FEATURES] },
          }),
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(sampleTenantStatus()));
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.tenant.status()).rejects.toMatchObject({
        code: "incompatible_host",
      });
      expect(health).toBe(2);
      expect(requests).toBe(1);
    } finally {
      await server.close();
    }
  });

  it("retries the request once when a 426 recheck still reports compatible", async () => {
    let health = 0;
    let requests = 0;
    const server = await startStubServer((request, response) => {
      if (request.url === "/health") {
        health += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify(healthBody()));
        return;
      }
      requests += 1;
      if (requests === 1) {
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
      response.end(JSON.stringify(sampleTenantStatus()));
    });
    try {
      const admin = createAdmin({ url: server.url, key: MANAGEMENT_KEY });
      await expect(admin.tenant.status()).resolves.toEqual(sampleTenantStatus());
      expect(health).toBe(2);
      expect(requests).toBe(2);
    } finally {
      await server.close();
    }
  });
});
