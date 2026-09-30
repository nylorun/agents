import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  OUTCOME_HEADER,
  SIGNATURE_HEADER,
} from "../src/compatibility.js";
import {
  ActionDeliveredPayloadSchema,
  ActionDeliveryFailedPayloadSchema,
  ActionDeliverySchema,
  ActionSchema,
  DELIVERY_TOKEN_MAX_TTL_SECONDS,
  DELIVERY_TOKEN_TYPE,
  DeliveryHeartbeatResponseSchema,
  ENDPOINT_TIMEOUT_DEFAULT_MS,
  ENDPOINT_TIMEOUT_MAX_MS,
  EndpointPingResponseSchema,
  EndpointSchema,
  ListEndpointsResponseSchema,
  PutEndpointsRequestSchema,
  TOKEN_TTL_MAX_SECONDS,
} from "../src/contracts.js";

const registration = {
  agentId: "support",
  url: "http://localhost:3000/nylorun/actions",
  implementationVersion: "dev",
};

const action = {
  actionId: "a1",
  sessionId: "s1",
  turnId: "t1",
  agentId: "support",
  manifestHash: "h1",
  implementationVersion: "dev",
  input: { q: 1 },
  context: {},
  status: "delivering",
  generation: 1,
  claimId: null,
  leaseExpiresAt: null,
  deadlineAt: "2026-09-30T12:01:00.000Z",
  kind: "tool",
  capabilityId: "support.tools",
  toolName: "lookup",
};

describe("endpoint registration", () => {
  it("accepts http and https URLs with optional limits", () => {
    expect(
      PutEndpointsRequestSchema.safeParse({
        endpoints: [
          registration,
          {
            ...registration,
            agentId: "triage",
            url: "https://app.example.com/nylorun/actions?x=1",
            manifestHash: "h1",
            timeoutMs: ENDPOINT_TIMEOUT_MAX_MS,
            maxConcurrent: 4,
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("refuses other schemes, credentials, fragments and bad URLs", () => {
    for (const url of [
      "ftp://example.com/actions",
      "https://user:pass@example.com/actions",
      "https://example.com/actions#x",
      "not a url",
      `https://example.com/${"x".repeat(2048)}`,
    ])
      expect(
        PutEndpointsRequestSchema.safeParse({ endpoints: [{ ...registration, url }] }).success,
        url.slice(0, 40),
      ).toBe(false);
  });

  it("bounds timeouts, concurrency and the batch, and needs unique agents", () => {
    const bad = [
      { ...registration, timeoutMs: ENDPOINT_TIMEOUT_MAX_MS + 1 },
      { ...registration, timeoutMs: 999 },
      { ...registration, maxConcurrent: 0 },
      { ...registration, maxConcurrent: 257 },
      { ...registration, token: "x".repeat(32) },
    ];
    for (const endpoint of bad)
      expect(PutEndpointsRequestSchema.safeParse({ endpoints: [endpoint] }).success).toBe(false);
    expect(PutEndpointsRequestSchema.safeParse({ endpoints: [] }).success).toBe(false);
    expect(
      PutEndpointsRequestSchema.safeParse({ endpoints: [registration, registration] }).success,
    ).toBe(false);
  });

  it("lists endpoints with their health", () => {
    const endpoint = {
      ...registration,
      timeoutMs: ENDPOINT_TIMEOUT_DEFAULT_MS,
      maxConcurrent: 16,
      health: {
        consecutiveFailures: 2,
        lastError: { code: "endpoint.unreachable", message: "ECONNREFUSED" },
        served: { implementationVersion: "dev", manifestHash: "h1" },
      },
      updatedAt: "2026-09-30T12:00:00.000Z",
    };
    expect(EndpointSchema.parse(endpoint)).toEqual(endpoint);
    expect(ListEndpointsResponseSchema.safeParse({ endpoints: [endpoint] }).success).toBe(true);
  });
});

describe("deliveries", () => {
  it("carries an Action in the delivering state, or a ping", () => {
    expect(ActionSchema.parse(action)).toEqual(action);
    expect(
      ActionDeliverySchema.safeParse({ type: "action", action, sandbox: false }).success,
    ).toBe(true);
    expect(
      ActionDeliverySchema.safeParse({ type: "ping", agentId: "support", manifestHash: "h1" })
        .success,
    ).toBe(true);
    expect(ActionDeliverySchema.safeParse({ type: "action", action }).success).toBe(false);
    expect(ActionDeliverySchema.safeParse({ type: "claim", action, sandbox: false }).success).toBe(
      false,
    );
  });

  it("still accepts Actions without a deadline", () => {
    const { deadlineAt: _, ...claimed } = action;
    expect(
      ActionSchema.safeParse({ ...claimed, status: "claimed", claimId: "c1", leaseExpiresAt: "x" })
        .success,
    ).toBe(true);
  });

  it("parses pings, heartbeats and delivery events", () => {
    expect(
      EndpointPingResponseSchema.safeParse({ agentId: "support", implementationVersion: "dev" })
        .success,
    ).toBe(true);
    expect(
      DeliveryHeartbeatResponseSchema.safeParse({ token: "t", deadlineAt: "x" }).success,
    ).toBe(true);
    expect(
      ActionDeliveredPayloadSchema.safeParse({ actionId: "a1", generation: 1 }).success,
    ).toBe(true);
    expect(
      ActionDeliveryFailedPayloadSchema.safeParse({
        actionId: "a1",
        generation: 1,
        reason: "unreachable",
        retryInMs: 250,
      }).success,
    ).toBe(true);
    expect(
      ActionDeliveredPayloadSchema.safeParse({ actionId: "a1", generation: 0 }).success,
    ).toBe(false);
  });
});

describe("delivery tokens", () => {
  it("live no longer than subject tokens, and inline timeouts fit inside them", () => {
    expect(DELIVERY_TOKEN_TYPE).toBe("nylorun-delivery+jwt");
    expect(DELIVERY_TOKEN_MAX_TTL_SECONDS).toBe(TOKEN_TTL_MAX_SECONDS);
    expect(ENDPOINT_TIMEOUT_MAX_MS).toBe(840_000);
    expect(ENDPOINT_TIMEOUT_MAX_MS).toBeLessThan(DELIVERY_TOKEN_MAX_TTL_SECONDS * 1000);
  });

  it("names the headers and the Host feature", () => {
    expect(SIGNATURE_HEADER).toBe("Nylorun-Signature");
    expect(OUTCOME_HEADER).toBe("Nylorun-Outcome");
    expect(HOST_PROTOCOL.features).toContain("action-endpoints");
  });
});
