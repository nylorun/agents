import { describe, expect, it } from "vitest";
import {
  HOST_PROTOCOL,
  PROTOCOL_FEATURES,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from "../src/compatibility.js";
import {
  advertisedProtocol,
  checkHealth,
  describeIncompatibility,
  parseBody,
  parseProtocolRange,
  requestHeaders,
} from "../src/transport.js";

const health = (protocol: unknown, init?: ResponseInit) =>
  (async () => Response.json({ status: "ok", protocol }, init)) as unknown as typeof fetch;

describe("the shared transport", () => {
  it("reads a protocol range, ignoring fields a newer Host adds, and refuses a malformed one", () => {
    expect(parseProtocolRange({ min: 4, max: 10, features: ["a"], optional: ["b"] })).toEqual({
      min: 4,
      max: 10,
      features: ["a"],
    });
    for (const value of [undefined, null, [], { min: 4, max: 10 }, { min: "4", max: 10, features: [] }])
      expect(parseProtocolRange(value)).toBeUndefined();
    expect(advertisedProtocol({ protocol: HOST_PROTOCOL })).toEqual(HOST_PROTOCOL);
    expect(advertisedProtocol("text")).toBeUndefined();
  });

  it("probes /health without a credential and says whether the Host serves this client", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetcher = (async (url: string, init?: RequestInit) => {
      calls.push({ url, ...(init ? { init } : {}) });
      return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
    }) as unknown as typeof fetch;
    expect(await checkHealth("http://127.0.0.1:8787", { fetch: fetcher })).toEqual({
      result: "compatible",
      protocol: HOST_PROTOCOL,
    });
    expect(calls[0]!.url).toBe("http://127.0.0.1:8787/health");
    expect(calls[0]!.init?.redirect).toBe("error");
    expect(new Headers(calls[0]!.init?.headers).get("authorization")).toBeNull();

    const newer = { min: PROTOCOL_VERSION + 1, max: PROTOCOL_VERSION + 1, features: [...PROTOCOL_FEATURES] };
    const incompatible = await checkHealth("http://h", { fetch: health(newer) });
    expect(incompatible.result).toBe("incompatible");
    if (incompatible.result === "incompatible")
      expect(describeIncompatibility(incompatible.compatibility)).toBe(
        `client protocol ${PROTOCOL_VERSION} is outside Host range ${PROTOCOL_VERSION + 1}–${PROTOCOL_VERSION + 1}`,
      );
    const missing = await checkHealth("http://h", {
      fetch: health({ min: 1, max: PROTOCOL_VERSION, features: [] }),
    });
    if (missing.result !== "incompatible") throw new Error("expected incompatible");
    expect(describeIncompatibility(missing.compatibility)).toBe(
      `Host is missing required features: ${PROTOCOL_FEATURES.join(", ")}`,
    );
    expect(await checkHealth("http://h", { fetch: health(undefined) })).toMatchObject({
      result: "unadvertised",
    });
    expect(
      await checkHealth("http://h", {
        fetch: (async () => new Response("down", { status: 503 })) as unknown as typeof fetch,
      }),
    ).toEqual({ result: "failed", status: 503, body: "down" });
  });

  it("sends the protocol and the bearer, and reads JSON or text bodies", () => {
    expect(requestHeaders("k")).toEqual({
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      authorization: "Bearer k",
    });
    expect(requestHeaders()).toEqual({ [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) });
    expect(parseBody('{"a":1}')).toEqual({ a: 1 });
    expect(parseBody("not json")).toBe("not json");
  });
});
