import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function fake(
  features: readonly string[] = HOST_PROTOCOL.features,
  respond: (method: string, path: string, body: any) => Response = () => Response.json({}),
) {
  const sent: { method: string; path: string; search: string; body?: any }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({
          status: "ok",
          protocol: { ...HOST_PROTOCOL, features: [...features] },
        });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const method = init?.method ?? "GET";
      // The raw path: a sandbox id's slash travels percent-encoded.
      const raw = String(input).slice(RUNTIME.length).split("?")[0]!;
      sent.push({ method, path: raw, search: url.search, body });
      return respond(method, raw, body);
    },
  });
  return { client, sent };
}

describe("client.sandboxes", () => {
  it("ensures, reads, lists by label and deletes by an id with slashes", async () => {
    const { client, sent } = fake(undefined, (method, path) =>
      path === "/v1/sandboxes"
        ? Response.json({ sandboxes: [{ id: "team-a/proj-42" }] })
        : method === "DELETE"
          ? Response.json({ id: "team-a/proj-42", deleted: true })
          : Response.json({ id: "team-a/proj-42" }),
    );
    await client.sandboxes.ensure("team-a/proj-42", { labels: { project: "acme" } });
    await client.sandboxes.get("team-a/proj-42");
    expect(await client.sandboxes.list({ labels: { project: "acme", team: "a" } })).toEqual([
      { id: "team-a/proj-42" },
    ]);
    expect(await client.sandboxes.delete("team-a/proj-42")).toEqual({
      id: "team-a/proj-42",
      deleted: true,
    });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/sandboxes/team-a%2Fproj-42",
      "GET /v1/sandboxes/team-a%2Fproj-42",
      "GET /v1/sandboxes",
      "DELETE /v1/sandboxes/team-a%2Fproj-42",
    ]);
    expect(sent[0]!.body).toMatchObject({ labels: { project: "acme" } });
    expect(typeof sent[0]!.body.requestId).toBe("string");
    expect(new URLSearchParams(sent[2]!.search).getAll("label")).toEqual([
      "project=acme",
      "team=a",
    ]);
  });

  it("refuses an id the Runtime would refuse, before sending anything", async () => {
    const { client, sent } = fake();
    await expect(client.sandboxes.ensure("bad id!")).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("sends nothing to a Runtime without the sandboxes feature", async () => {
    const { client, sent } = fake(
      HOST_PROTOCOL.features.filter((feature) => feature !== "sandboxes"),
    );
    await expect(client.sandboxes.ensure("user-42")).rejects.toThrow(/sandboxes/);
    expect(sent).toEqual([]);
  });

  it("forSession creates a sandbox, attaches the session, and release deletes it", async () => {
    const { client, sent } = fake();
    const handle = await client.sandboxes.forSession({
      session: { id: "s1", agentId: "bot", ownerUserId: "app:42" },
      spec: { network: { allow: ["api.github.com"] } },
    });
    expect(handle.session.id).toBe("s1");
    await handle.release();
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/sandboxes/sessions%2Fs1",
      "PUT /v1/sessions/s1",
      "DELETE /v1/sandboxes/sessions%2Fs1",
    ]);
    expect(sent[1]!.body).toMatchObject({
      agentId: "bot",
      ownerUserId: "app:42",
      sandbox: { id: "sessions/s1" },
    });
  });

  it("forSession deletes the sandbox again when the session cannot be opened", async () => {
    const { client, sent } = fake(undefined, (method, path) =>
      method === "PUT" && path.startsWith("/v1/sessions/")
        ? Response.json({ status: "rejected", code: "request_rejected", message: "no" }, { status: 404 })
        : Response.json({}),
    );
    await expect(
      client.sandboxes.forSession({
        session: { id: "s2", agentId: "missing", ownerUserId: "app:42" },
      }),
    ).rejects.toThrow();
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/sandboxes/sessions%2Fs2",
      "PUT /v1/sessions/s2",
      "DELETE /v1/sandboxes/sessions%2Fs2",
    ]);
  });
});

describe("client.tokens with sandboxes", () => {
  it("mints the sbx grants it is given", async () => {
    const { client, sent } = fake(undefined, () => Response.json({ token: "t" }));
    await client.tokens.create({ subject: "app:42", role: "user", sandboxes: ["team-a/*"] });
    expect(sent[0]!.body).toMatchObject({ sandboxes: ["team-a/*"] });
  });
});
