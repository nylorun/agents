import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { STACK_ENABLED, stackEndpoints } from "./endpoints.js";

/** Postgres answers an SSLRequest with one byte, `S` or `N`, before any authentication. */
function postgresSslAnswer(host: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host, port });
    socket.setTimeout(5000, () => {
      socket.destroy();
      reject(new Error("Postgres did not answer"));
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      const request = Buffer.alloc(8);
      request.writeInt32BE(8, 0);
      request.writeInt32BE(80877103, 4);
      socket.write(request);
    });
    socket.on("data", (data) => {
      socket.destroy();
      resolve(String.fromCharCode(data[0]!));
    });
  });
}

describe.skipIf(!STACK_ENABLED)("integration test stack", () => {
  const endpoints = stackEndpoints();

  it("Postgres answers the wire protocol", async () => {
    const answer = await postgresSslAnswer(
      endpoints.postgres.host,
      endpoints.postgres.port,
    );
    expect(["S", "N"]).toContain(answer);
  });

  it("Restate admin and ingress respond", async () => {
    const admin = await fetch(`${endpoints.restate.adminUrl}/health`);
    expect(admin.status).toBe(200);
    const services = await fetch(`${endpoints.restate.adminUrl}/services`);
    expect(services.status).toBe(200);
    expect(await services.json()).toHaveProperty("services");
    const ingress = await fetch(`${endpoints.restate.ingressUrl}/restate/health`);
    expect(ingress.status).toBe(200);
  });

  it("s2-lite responds", async () => {
    const health = await fetch(`${endpoints.s2.endpoint}/health`);
    expect(health.status).toBe(200);
    const basins = await fetch(`${endpoints.s2.endpoint}/v1/basins`);
    expect(basins.status).toBe(200);
    expect(await basins.json()).toHaveProperty("basins");
  });
});
