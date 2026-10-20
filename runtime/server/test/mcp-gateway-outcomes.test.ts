/** #495: which gateway answers report that the server behind the gateway refused the credential. */
import { describe, expect, it } from "vitest";
import { gatewayAuthFailure } from "../src/mcp/gateway-outcomes.js";

const outcomes = (entries: Record<string, unknown>) => ({ _meta: { "litellm.ai/server_outcomes": entries } });

describe("gatewayAuthFailure", () => {
  it("reads LiteLLM's outcome for the server by its name, by status or by HTTP status", () => {
    expect(gatewayAuthFailure({ tools: [], ...outcomes({ github: { status: "auth_required" } }) }, ["github"])).toBe(true);
    expect(gatewayAuthFailure({ tools: [], ...outcomes({ github: { http_status: 401 } }) }, ["github"])).toBe(true);
    expect(gatewayAuthFailure({ tools: [], ...outcomes({ github: { status: "ok", http_status: 200 } }) }, ["github"])).toBe(
      false,
    );
  });

  it("reads the only entry when none has the server's name, and no entry when several do not", () => {
    expect(gatewayAuthFailure(outcomes({ gh: { status: "auth_required" } }), ["github"])).toBe(true);
    expect(
      gatewayAuthFailure(outcomes({ gh: { status: "auth_required" }, linear: { status: "ok" } }), ["github"]),
    ).toBe(false);
    expect(
      gatewayAuthFailure(outcomes({ github: { status: "ok" }, linear: { status: "auth_required" } }), ["github"]),
    ).toBe(false);
  });

  it("reads LiteLLM's 401 text only in a tool error", () => {
    const content = [{ type: "text", text: "HTTPStatusError: Client error '401 Unauthorized' for url 'https://x/'" }];
    expect(gatewayAuthFailure({ isError: true, content }, ["github"])).toBe(true);
    expect(gatewayAuthFailure({ content }, ["github"])).toBe(false);
    expect(gatewayAuthFailure({ isError: true, content: [{ type: "text", text: "401 Unauthorized" }] }, ["github"])).toBe(
      false,
    );
  });

  it("ignores answers without a gateway's outcome", () => {
    for (const answer of [undefined, null, "text", [], { tools: [] }, { _meta: { other: 1 } }])
      expect(gatewayAuthFailure(answer, ["github"])).toBe(false);
  });
});
