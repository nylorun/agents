import type { HostEffect } from "@nylorun/harness/run";
/** Providers are runtime-owned; neither credentials nor model selection enter manifests. */
export type ModelProvider = (
  effect: HostEffect,
  signal: AbortSignal,
) => Promise<unknown>;
export function scriptedModel(
  output = "Scripted development response",
): ModelProvider {
  return async () => ({ output: [{ type: "text", text: output }] });
}
/** A configured gateway receives the complete harness model call, including history and schemas. */
export function gatewayModel(options: {
  url: string;
  token: string;
  model: string;
}): ModelProvider {
  return async (effect, signal) => {
    const response = await fetch(options.url, {
      method: "POST",
      signal,
      headers: {
        authorization: `Bearer ${options.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: options.model,
        call: effect.input,
        context: effect.context,
      }),
    });
    if (!response.ok)
      throw new Error(`Model gateway returned ${response.status}`);
    return response.json();
  };
}

/**
 * Deterministic release fixture; still uses the real engine. With a `lookup_order` tool it looks
 * up the demo order through it once; without one it answers in text.
 */
export function toolFixtureModel(): ModelProvider {
  return async (effect) => {
    const call = effect.input as import("@nylorun/harness/run").ModelCall;
    const last = call.prompt.at(-1);
    if (last?.kind === "tool-result")
      return {
        output: [
          {
            type: "text",
            text: `Order lookup complete: ${last.content.map((part) => (part.type === "text" ? part.text : JSON.stringify(part))).join(" ")}`,
          },
        ],
      };
    const users = call.prompt.filter(
      (p) => p.kind === "message" && p.role === "user",
    );
    if (users.length > 1)
      return {
        output: [
          {
            type: "text",
            text: `I remember: ${users[0]!.content.map((part) => (part.type === "text" ? part.text : "")).join(" ")}`,
          },
        ],
      };
    if (!call.tools.some((tool) => tool.name === "lookup_order"))
      return { output: [{ type: "text", text: "Hello from the fixture model." }] };
    return {
      output: [
        {
          type: "tool-call",
          id: "fixture_lookup",
          name: "lookup_order",
          args: { orderId: "demo-123" },
        },
      ],
    };
  };
}
