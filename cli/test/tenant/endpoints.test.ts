import { expect, it } from "vitest";
import { endpointLine } from "../../src/tenant/commands.js";

const endpoint = (health: Parameters<typeof endpointLine>[0]["health"]) => ({
  agentId: "support",
  url: "http://localhost:3000/actions",
  implementationVersion: "dev",
  health,
});

it("says how each endpoint is doing", () => {
  expect(endpointLine(endpoint({ consecutiveFailures: 0 }))).toBe(
    "support  http://localhost:3000/actions  dev  no deliveries yet",
  );
  expect(endpointLine(endpoint({ consecutiveFailures: 0, lastSuccessAt: "2030-01-01T00:00:00.000Z" }))).toBe(
    "support  http://localhost:3000/actions  dev  ok (last 2030-01-01T00:00:00.000Z)",
  );
  expect(
    endpointLine(
      endpoint({
        consecutiveFailures: 3,
        lastError: { code: "endpoint.unreachable", message: "connect ECONNREFUSED 127.0.0.1:3000" },
      }),
    ),
  ).toBe("support  http://localhost:3000/actions  dev  failing (3): connect ECONNREFUSED 127.0.0.1:3000");
  expect(endpointLine(endpoint({ consecutiveFailures: 1, lastError: { code: "endpoint.busy", message: "" } }))).toMatch(
    /failing \(1\): endpoint.busy$/,
  );
});
