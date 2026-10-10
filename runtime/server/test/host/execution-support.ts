/**
 * Helpers for the Host execution tests (`execution.test.ts`, `execution.integration.test.ts`):
 * a Tenant booted with the test shim, a turn opened over the Tenant API, and models the test
 * controls.
 */
import { expect } from "vitest";
import { Agent } from "@nylorun/core/define";
import type { ModelProvider } from "../../src/core/provider.js";
import { openTestSessionStore } from "../support/store.js";
import { startTestTenant, type StartTestTenantOptions } from "../support/tenant.js";

export const APP = "host-execution-app-token-aaaaaaa";
export const server = {
  authorization: `Bearer ${APP}`,
  "content-type": "application/json",
};

export type Started = Awaited<ReturnType<typeof startTestTenant>>;

export const plain = Agent({ id: "bot", name: "Bot" }).build();

export async function boot(options: StartTestTenantOptions): Promise<Started> {
  return startTestTenant({
    applicationKey: APP,
    ...options,
  });
}

/** Registers the agent (once) and creates session `id`. */
export async function openSession(runtime: Started, id = "s1", register = true) {
  if (register) {
    const put = await fetch(`${runtime.url}/v1/agents/bot`, {
      method: "PUT",
      headers: server,
      body: JSON.stringify({
        requestId: "put-1",
        manifest: plain.manifest,
        implementationVersion: "dev",
      }),
    });
    expect(put.ok).toBe(true);
  }
  const session = await fetch(`${runtime.url}/v1/sessions/${id}`, {
    method: "PUT",
    headers: server,
    body: JSON.stringify({ requestId: `session-${id}`, agentId: "bot", ownerUserId: "u" }),
  });
  expect(session.ok).toBe(true);
}

export async function sendMessage(runtime: Started, id = "s1", n = 1) {
  const message = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({
      type: "message",
      requestId: `msg-${id}-${n}`,
      idempotencyKey: `msg-${id}-${n}`,
      content: "hello",
    }),
  });
  expect(message.ok).toBe(true);
}

export async function cancel(runtime: Started, id = "s1") {
  const response = await fetch(`${runtime.url}/v1/sessions/${id}/commands`, {
    method: "POST",
    headers: server,
    body: JSON.stringify({
      type: "cancel",
      requestId: `cancel-${id}`,
      idempotencyKey: `cancel-${id}`,
    }),
  });
  expect(response.ok).toBe(true);
}

export async function view(runtime: Started, id = "s1") {
  return (await (
    await fetch(`${runtime.url}/v1/sessions/${id}`, { headers: server })
  ).json()) as { status: string };
}

export async function types(runtime: Started, id = "s1") {
  const body = (await (
    await fetch(`${runtime.url}/v1/sessions/${id}/items`, { headers: server })
  ).json()) as { items: { type: string; payload?: unknown }[] };
  return body.items.map((item) => item.type);
}

export async function until<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export const count = (list: string[], type: string) =>
  list.filter((item) => item === type).length;

/** Reads the session row and its effects straight from the Tenant's store. */
export async function stored(runtime: Started, id = "s1") {
  const store = await openTestSessionStore(runtime);
  try {
    return await store.tx(async (t) => ({
      session: (await t.get("sessions", id)) as {
        status: string;
        owner: string | null;
        epoch: number;
      },
      effects: await t.effectsForSession(id, {
        statuses: ["invoking", "uncertain", "completed"],
      }),
    }));
  } finally {
    await store.close();
  }
}

/**
 * A model call the test controls. `honorAbort` makes it reject when its signal aborts, like a
 * real provider; without it the call ignores the signal and runs until `release()`.
 */
export function controlledModel(options: { honorAbort?: boolean } = {}) {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const model = {
    calls: 0,
    aborted: 0,
    started,
    release: () => release(),
    provider: (async (_effect, signal) => {
      model.calls += 1;
      entered();
      if (options.honorAbort)
        await new Promise<void>((resolve, reject) => {
          void gate.then(resolve);
          const onAbort = () => {
            model.aborted += 1;
            reject(signal.reason ?? new Error("aborted"));
          };
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        });
      else await gate;
      return { output: [{ type: "text", text: "done" }] };
    }) as ModelProvider,
  };
  return model;
}
