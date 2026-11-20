/**
 * A message's `context` (Host feature `message-context`, ADR-157): facts for its own turn only.
 * The Runtime passes them to the turn as its input's `metadata.context`, keeps them on the
 * `command.message` event, and refuses more than its limits.
 */
import { expect, it } from "vitest";
import { Agent } from "@nylorun/agents";
import { OPTIONAL_HOST_FEATURES } from "@nylorun/core/compatibility";
import { MESSAGE_CONTEXT_MAX_BYTES } from "@nylorun/core/contracts";
import { startTestTenant } from "./support/tenant.js";
import { deploy, openSession } from "./support/agents.js";
import type { ModelProvider } from "../src/core/provider.js";

const APP = "message-context-token-aaaaaaaaa";
const headers = { authorization: `Bearer ${APP}`, "content-type": "application/json" };

/** A model that answers `ok` and keeps each call's prompt. */
function recording(seen: string[]): ModelProvider {
  return async (effect) => {
    seen.push(JSON.stringify((effect.input as { prompt?: unknown }).prompt));
    return { output: [{ type: "text", text: "ok" }] };
  };
}

async function send(url: string, id: string, key: string, extra: Record<string, unknown> = {}) {
  return fetch(`${url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers,
    body: JSON.stringify({ type: "message", requestId: key, idempotencyKey: key, content: "hello", ...extra }),
  });
}

async function settled(url: string, id: string) {
  let session: Record<string, any> = { status: "" };
  for (let attempt = 0; attempt < 400 && !["completed", "failed"].includes(session.status); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    session = (await (await fetch(`${url}/v1/sessions/${id}`, { headers })).json()) as Record<string, any>;
  }
  return session;
}

it("is a Host feature", () => {
  expect(OPTIONAL_HOST_FEATURES).toContain("message-context");
});

it("reaches its own turn's calls only, and stays on command.message", async () => {
  const seen: string[] = [];
  const runtime = await startTestTenant({
    mode: "test",
    applicationKey: APP,
    vaultKek: null,
    modelProvider: recording(seen),
    sandbox: { backend: "virtual" },
  });
  try {
    await deploy(runtime.url, headers, Agent({ id: "bot", name: "bot" }).instructions("Answer.").build());
    expect((await openSession(runtime.url, headers, "s1", { agent: "bot", ownerUserId: "ada" })).ok).toBe(true);
    const context = [{ type: "bot", value: "[bot] Nylo · 10:00" }, { value: { tasks: 2 } }];
    const sent = await send(runtime.url, "s1", "m1", { context });
    expect(sent.ok, await sent.clone().text()).toBe(true);
    expect((await settled(runtime.url, "s1")).status).toBe("completed");
    expect(seen.at(-1)).toContain("<runtime-context>");
    expect(seen.at(-1)).toContain("[bot] Nylo · 10:00");

    const next = await send(runtime.url, "s1", "m2");
    expect(next.ok).toBe(true);
    expect((await settled(runtime.url, "s1")).status).toBe("completed");
    expect(seen.at(-1)).not.toContain("<runtime-context>");
    // The person's words stay as sent; the context is not part of the message.
    expect(seen.at(-1)).toContain("hello");
    expect(seen.at(-1)).not.toContain("[bot] Nylo");

    const items = (await (await fetch(`${runtime.url}/v1/sessions/s1/items`, { headers })).json()) as {
      items: { type: string; payload: any }[];
    };
    const messages = items.items.filter((item) => item.type === "command.message").map((item) => item.payload.context);
    expect(messages).toEqual([context, undefined]);

    // The limits: 16 items, 16 KiB.
    const many = Array.from({ length: 17 }, (_, index) => ({ value: index }));
    expect((await send(runtime.url, "s1", "m3", { context: many })).status).toBe(400);
    const large = [{ value: "x".repeat(MESSAGE_CONTEXT_MAX_BYTES) }];
    expect((await send(runtime.url, "s1", "m4", { context: large })).status).toBe(400);
    expect((await send(runtime.url, "s1", "m5", { context: [{ type: "", value: 1 }] })).status).toBe(400);
  } finally {
    await runtime.close();
  }
});
