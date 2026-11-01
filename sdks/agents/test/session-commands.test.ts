import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

/** A client whose Runtime accepts every command, and the bodies it was sent. */
function accepting() {
  const bodies: Record<string, unknown>[] = [];
  const client = new AgentsClient({
    url: "http://127.0.0.1:8787",
    key: "a".repeat(64),
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health") return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ status: "accepted", turnId: "t1", cursor: null, requestId: "r1" });
    },
  });
  return { client, bodies };
}

describe("session commands", () => {
  it("approve and respond take no options: each makes its own idempotency key (review item 12)", async () => {
    const { client, bodies } = accepting();
    const session = client.session("s1");
    await session.approve("i1", true);
    await session.respond("i2", { answer: 42 });
    await session.approve("i3", false, { idempotencyKey: "mine" });
    expect(bodies).toEqual([
      expect.objectContaining({ type: "approve", interactionId: "i1", approved: true, idempotencyKey: expect.any(String) }),
      expect.objectContaining({ type: "respond", interactionId: "i2", value: { answer: 42 }, idempotencyKey: expect.any(String) }),
      expect.objectContaining({ type: "approve", interactionId: "i3", approved: false, idempotencyKey: "mine" }),
    ]);
    expect(bodies[0]!.idempotencyKey).not.toBe(bodies[1]!.idempotencyKey);
  });

  it("sends removeTools with a message, when the Runtime serves remove-tools", async () => {
    const { client, bodies } = accepting();
    const session = client.session("s1");
    await session.input("hi", { idempotencyKey: "k1", removeTools: ["deploy", "github__delete_repo"] });
    await session.inputParts([{ type: "text", text: "hi" }], { idempotencyKey: "k2", removeTools: ["github"] });
    await session.input("hi", { idempotencyKey: "k3", removeTools: [] });
    expect(bodies).toEqual([
      expect.objectContaining({ type: "message", content: "hi", removeTools: ["deploy", "github__delete_repo"] }),
      expect.objectContaining({ type: "message", parts: [{ type: "text", text: "hi" }], removeTools: ["github"] }),
      expect.not.objectContaining({ removeTools: expect.anything() }),
    ]);
  });

  it("refuses removeTools before sending it to a Runtime without remove-tools", async () => {
    const sent: unknown[] = [];
    const client = new AgentsClient({
      url: "http://127.0.0.1:8787",
      key: "a".repeat(64),
      fetch: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/health")
          return Response.json({
            status: "ok",
            protocol: { ...HOST_PROTOCOL, features: HOST_PROTOCOL.features.filter((feature) => feature !== "remove-tools") },
          });
        sent.push(init?.body);
        return Response.json({ status: "accepted", turnId: "t1", cursor: null, requestId: "r1" });
      },
    });
    await expect(client.session("s1").input("hi", { idempotencyKey: "k1", removeTools: ["deploy"] })).rejects.toThrow(
      /remove-tools/,
    );
    expect(sent).toEqual([]);
  });
});
