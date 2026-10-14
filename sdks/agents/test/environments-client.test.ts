import { describe, expect, it } from "vitest";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { AgentsClient } from "../src/client.js";

const KEY = "a".repeat(64);
const RUNTIME = "http://127.0.0.1:8787";

function fake(
  respond: (method: string, path: string, body: any) => Response = () => Response.json({}),
) {
  const sent: { method: string; path: string; search: string; body?: any }[] = [];
  const client = new AgentsClient({
    url: RUNTIME,
    key: KEY,
    fetch: async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname === "/health")
        return Response.json({ status: "ok", protocol: HOST_PROTOCOL });
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      const method = init?.method ?? "GET";
      // The raw path: an Environment id's slash travels percent-encoded.
      const raw = String(input).slice(RUNTIME.length).split("?")[0]!;
      sent.push({ method, path: raw, search: url.search, body });
      return respond(method, raw, body);
    },
  });
  return { client, sent };
}

describe("client.environments", () => {
  it("puts, reads, lists by label, stops, resets and deletes by an id with slashes", async () => {
    const { client, sent } = fake((method, path) =>
      path === "/v1/environments"
        ? Response.json({ environments: [{ id: "users/alice/web" }] })
        : method === "DELETE"
          ? Response.json({ id: "users/alice/web", deleted: true })
          : Response.json({ id: "users/alice/web" }),
    );
    await client.environments.put("users/alice/web", {
      kind: "pod",
      image: "node:22-bookworm",
      labels: { user: "alice" },
      ownerUserId: "alice",
    });
    await client.environments.get("users/alice/web");
    expect(await client.environments.list({ labels: { user: "alice", team: "a" } })).toEqual([
      { id: "users/alice/web" },
    ]);
    await client.environments.stop("users/alice/web");
    await client.environments.reset("users/alice/web");
    expect(await client.environments.delete("users/alice/web")).toEqual({
      id: "users/alice/web",
      deleted: true,
    });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/environments/users%2Falice%2Fweb",
      "GET /v1/environments/users%2Falice%2Fweb",
      "GET /v1/environments",
      "POST /v1/environments/users%2Falice%2Fweb/stop",
      "POST /v1/environments/users%2Falice%2Fweb/reset",
      "DELETE /v1/environments/users%2Falice%2Fweb",
    ]);
    expect(sent[0]!.body).toMatchObject({ kind: "pod", labels: { user: "alice" }, ownerUserId: "alice" });
    expect(typeof sent[0]!.body.requestId).toBe("string");
    expect(new URLSearchParams(sent[2]!.search).getAll("label")).toEqual(["user=alice", "team=a"]);
  });

  it("writes, lists and deletes secrets by name; values are sent, never read", async () => {
    const { client, sent } = fake((method, path) =>
      path.endsWith("/secrets")
        ? Response.json({ secrets: [{ name: "GH_TOKEN", type: "environment_secret" }] })
        : Response.json({ name: "GH_TOKEN", type: "environment_secret" }),
    );
    await client.environments.secrets.put("users/alice/web", "GH_TOKEN", {
      type: "environment_secret",
      value: "ghp_x",
      allowedHosts: ["github.com"],
    });
    expect(await client.environments.secrets.list("users/alice/web")).toEqual([
      { name: "GH_TOKEN", type: "environment_secret" },
    ]);
    await client.environments.secrets.delete("users/alice/web", "GH_TOKEN");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/environments/users%2Falice%2Fweb/secrets/GH_TOKEN",
      "GET /v1/environments/users%2Falice%2Fweb/secrets",
      "DELETE /v1/environments/users%2Falice%2Fweb/secrets/GH_TOKEN",
    ]);
    expect(sent[0]!.body).toMatchObject({ type: "environment_secret", value: "ghp_x" });
  });

  it("forks into a new Environment, and plans a fork without making one", async () => {
    const plan = { source: "users/alice/web", id: "users/alice/web-2", disk: 3 };
    const { client, sent } = fake((_method, _path, body) =>
      Response.json(body.dryRun ? { dryRun: true, plan } : { environment: { id: "users/alice/web-2" }, plan }),
    );
    const forked = await client.environments.fork("users/alice/web", { id: "users/alice/web-2", manifest: "web@2" });
    expect(forked.environment.id).toBe("users/alice/web-2");
    expect(await client.environments.planFork("users/alice/web", { id: "users/alice/web-2", disk: "empty" })).toEqual(plan);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/environments/users%2Falice%2Fweb/fork",
      "POST /v1/environments/users%2Falice%2Fweb/fork",
    ]);
    expect(sent[0]!.body).toMatchObject({ id: "users/alice/web-2", manifest: "web@2" });
    expect(sent[0]!.body.requestId).toEqual(expect.any(String));
    expect(sent[1]!.body).toEqual({ id: "users/alice/web-2", disk: "empty", dryRun: true });
  });

  it("refuses an id the Runtime would refuse, before sending anything", async () => {
    const { client, sent } = fake();
    await expect(client.environments.put("bad id!")).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("forSession creates an Environment, writes its secrets, opens the session on it, and release deletes it", async () => {
    const { client, sent } = fake();
    const handle = await client.environments.forSession({
      session: { id: "s1", agentId: "bot", ownerUserId: "app:42" },
      recipe: { network: { allowedHosts: ["api.github.com"] } },
      secrets: { REGION: { type: "environment_variable", value: "eu-west-1" } },
    });
    expect(handle.session.id).toBe("s1");
    await handle.release();
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/environments/sessions%2Fs1",
      "PUT /v1/environments/sessions%2Fs1/secrets/REGION",
      "PUT /v1/sessions/s1",
      "DELETE /v1/environments/sessions%2Fs1",
    ]);
    expect(sent[2]!.body).toMatchObject({
      agentId: "bot",
      ownerUserId: "app:42",
      environment: "sessions/s1",
    });
  });

  it("forSession deletes the Environment again when the session cannot be opened", async () => {
    const { client, sent } = fake((method, path) =>
      method === "PUT" && path.startsWith("/v1/sessions/")
        ? Response.json({ status: "rejected", code: "request_rejected", message: "no" }, { status: 404 })
        : Response.json({}),
    );
    await expect(
      client.environments.forSession({
        session: { id: "s2", agentId: "missing", ownerUserId: "app:42" },
      }),
    ).rejects.toThrow();
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/environments/sessions%2Fs2",
      "PUT /v1/sessions/s2",
      "DELETE /v1/environments/sessions%2Fs2",
    ]);
  });
});
