/**
 * The browser-direct example against a real Runtime with browser access: the backend signs
 * people in and mints tokens; the page (simulated here, with the `Origin` and cookie a browser
 * sends) talks to the Runtime directly over AG-UI, through an approval.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BaseEvent } from "@ag-ui/client";
import { createClient } from "@nylorun/agents";
import { startEphemeralRuntime, type EphemeralRuntime } from "@nylorun/runtime";
import { createDirectApp } from "../src/browser-direct/app.js";
import { startChat } from "../src/browser-direct/chat.js";
import { setUpAccess } from "../src/browser-direct/setup.js";

const PAGE = "http://localhost:5173";
let root: string;
let runtime: EphemeralRuntime;
let server: Server;
let appOrigin: string;
let app: ReturnType<typeof createDirectApp>;

/** What a browser on the page sends: its Origin to the Runtime, its cookie to the app. */
function pageFetch(user: string): typeof fetch {
  return (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    const headers = new Headers(init?.headers);
    if (url.startsWith(appOrigin)) headers.set("cookie", `demo_user=${user}`);
    else headers.set("origin", PAGE);
    return fetch(input, { ...init, headers });
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "nylorun-browser-direct-"));
  runtime = await startEphemeralRuntime({
    hostRoot: root,
    browserAccess: true,
    model: { kind: "fixture" },
  });
  const client = createClient({
    url: runtime.url,
    key: runtime.applicationKey,
    tenant: runtime.tenantId,
  });
  const { publishableKey } = await setUpAccess(client);
  // Running setup again keeps the same key.
  expect((await setUpAccess(client)).publishableKey).toBe(publishableKey);
  app = createDirectApp({ client, runtimeUrl: runtime.url, publishableKey });
  await app.connection.ready;
  server = createServer(app.listener);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  appOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  await new Promise((resolve) => server?.close(resolve));
  await app?.connection.close();
  await runtime?.close();
  await rm(root, { recursive: true, force: true });
});

describe("the browser-direct example", () => {
  it("chats with an approval from the page, straight to the Runtime", async () => {
    const seen: BaseEvent[] = [];
    const { agent } = await startChat({
      appOrigin,
      threadId: "t1",
      fetch: pageFetch("ada"),
      onEvent: (event) => seen.push(event),
    });
    agent.addMessage({ id: "m1", role: "user", content: "Where is order demo-123?" });
    await agent.runAgent({ runId: "r1" });
    const paused = seen.findLast((event) => event.type === "RUN_FINISHED") as {
      outcome?: { type: string; interrupts: { id: string }[] };
    };
    expect(paused.outcome?.type).toBe("interrupt");
    seen.length = 0;
    await agent.runAgent({
      runId: "r2",
      resume: [
        { interruptId: paused.outcome!.interrupts[0]!.id, status: "resolved", payload: { approved: true } },
      ],
    });
    expect(seen.map((event) => event.type)).toContain("TOOL_CALL_RESULT");
    expect(seen.at(-1)!.type).toBe("RUN_FINISHED");

    // A reload rebuilds the same thread from history, and another person sees none of it.
    const reloaded = await startChat({ appOrigin, threadId: "t1", fetch: pageFetch("ada") });
    expect(reloaded.agent.messages.map((m) => m.id)).toEqual(agent.messages.map((m) => m.id));
    const other = await startChat({ appOrigin, threadId: "t1", fetch: pageFetch("bob") });
    expect(other.agent.messages).toEqual([]);
  });

  it("gives a page nothing without sign-in, and never the application key", async () => {
    const token = await fetch(`${appOrigin}/api/nylorun/token`, { method: "POST" });
    expect(token.status).toBe(401);
    const config = await (await fetch(`${appOrigin}/api/nylorun/config`)).text();
    expect(config).not.toContain(runtime.applicationKey);
    const minted = await (
      await fetch(`${appOrigin}/api/nylorun/token`, {
        method: "POST",
        headers: { cookie: "demo_user=ada" },
      })
    ).text();
    expect(minted).not.toContain(runtime.applicationKey);
  });
});
