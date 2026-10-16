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
      // The raw path: an Agent id's slash travels percent-encoded.
      const raw = String(input).slice(RUNTIME.length).split("?")[0]!;
      sent.push({ method, path: raw, search: url.search, body });
      return respond(method, raw, body);
    },
  });
  return { client, sent };
}

describe("client.agents", () => {
  it("puts from a manifest, reads, lists by label, state and manifest, stops, resets and deletes by an id with slashes", async () => {
    const { client, sent } = fake((method, path) =>
      path === "/v1/agents"
        ? Response.json({ agents: [{ id: "users/alice/triage" }] })
        : method === "DELETE"
          ? Response.json({ id: "users/alice/triage", deleted: true })
          : Response.json({ id: "users/alice/triage" }),
    );
    await client.agents.put("users/alice/triage", {
      manifest: "triage@3",
      labels: { user: "alice" },
      owner: "alice",
    });
    await client.agents.get("users/alice/triage");
    expect(
      await client.agents.list({ labels: { user: "alice", team: "a" }, state: "working", manifest: "triage" }),
    ).toEqual([{ id: "users/alice/triage" }]);
    await client.agents.stop("users/alice/triage");
    await client.agents.reset("users/alice/triage");
    expect(await client.agents.delete("users/alice/triage")).toEqual({ id: "users/alice/triage", deleted: true });
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/agents/users%2Falice%2Ftriage",
      "GET /v1/agents/users%2Falice%2Ftriage",
      "GET /v1/agents",
      "POST /v1/agents/users%2Falice%2Ftriage/stop",
      "POST /v1/agents/users%2Falice%2Ftriage/reset",
      "DELETE /v1/agents/users%2Falice%2Ftriage",
    ]);
    expect(sent[0]!.body).toMatchObject({ manifest: "triage@3", labels: { user: "alice" }, owner: "alice" });
    expect(typeof sent[0]!.body.requestId).toBe("string");
    const query = new URLSearchParams(sent[2]!.search);
    expect(query.getAll("label")).toEqual(["user=alice", "team=a"]);
    expect(query.get("state")).toBe("working");
    expect(query.get("manifest")).toBe("triage");
  });

  it("writes, lists and deletes secrets by name; values are sent, never read", async () => {
    const { client, sent } = fake((_method, path) =>
      path.endsWith("/secrets")
        ? Response.json({ secrets: [{ name: "GH_TOKEN", type: "environment_secret" }] })
        : Response.json({ name: "GH_TOKEN", type: "environment_secret" }),
    );
    await client.agents.secrets.put("users/alice/triage", "GH_TOKEN", { value: "ghp_x" });
    await client.agents.secrets.put("users/alice/triage", "linear", {
      type: "bearer",
      url: "https://mcp.linear.app/mcp",
      value: "lin_x",
    });
    expect(await client.agents.secrets.list("users/alice/triage")).toEqual([
      { name: "GH_TOKEN", type: "environment_secret" },
    ]);
    await client.agents.secrets.get("users/alice/triage", "GH_TOKEN");
    await client.agents.secrets.delete("users/alice/triage", "GH_TOKEN");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "PUT /v1/agents/users%2Falice%2Ftriage/secrets/GH_TOKEN",
      "PUT /v1/agents/users%2Falice%2Ftriage/secrets/linear",
      "GET /v1/agents/users%2Falice%2Ftriage/secrets",
      "GET /v1/agents/users%2Falice%2Ftriage/secrets/GH_TOKEN",
      "DELETE /v1/agents/users%2Falice%2Ftriage/secrets/GH_TOKEN",
    ]);
    expect(sent[0]!.body).toMatchObject({ value: "ghp_x" });
    expect(sent[1]!.body).toMatchObject({ type: "bearer", url: "https://mcp.linear.app/mcp" });
  });

  it("lists, reads, writes, deletes memories and pages their versions by a path with slashes", async () => {
    const { client, sent } = fake(() => Response.json({}));
    await client.agents.memories.list("users/alice/triage", { pathPrefix: "conventions" });
    await client.agents.memories.get("users/alice/triage", "/memories/conventions/release.md");
    await client.agents.memories.put("users/alice/triage", "conventions/release.md", "Cut from release/x.y.", { contentSha256: "" });
    await client.agents.memories.delete("users/alice/triage", "conventions");
    await client.agents.memories.versions("users/alice/triage", { path: "conventions/release.md" });
    await client.agents.memories.version("users/alice/triage", "mv_1");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "GET /v1/agents/users%2Falice%2Ftriage/memories",
      "GET /v1/agents/users%2Falice%2Ftriage/memories/conventions%2Frelease.md",
      "PUT /v1/agents/users%2Falice%2Ftriage/memories/conventions%2Frelease.md",
      "DELETE /v1/agents/users%2Falice%2Ftriage/memories/conventions",
      "GET /v1/agents/users%2Falice%2Ftriage/memory_versions",
      "GET /v1/agents/users%2Falice%2Ftriage/memory_versions/mv_1",
    ]);
    expect(new URLSearchParams(sent[0]!.search).get("pathPrefix")).toBe("conventions");
    expect(sent[2]!.body).toEqual({ content: "Cut from release/x.y.", contentSha256: "" });
    expect(new URLSearchParams(sent[4]!.search).get("path")).toBe("conventions/release.md");
  });

  it("forks into a new Agent, and plans a fork without making one", async () => {
    const plan = { source: "users/alice/triage", id: "users/alice/triage-2", disk: 3 };
    const { client, sent } = fake((_method, _path, body) =>
      Response.json(body.dryRun ? { dryRun: true, plan } : { agent: { id: "users/alice/triage-2" }, plan }),
    );
    const forked = await client.agents.fork("users/alice/triage", { id: "users/alice/triage-2", manifest: "triage@4" });
    expect(forked.agent.id).toBe("users/alice/triage-2");
    expect(await client.agents.planFork("users/alice/triage", { id: "users/alice/triage-2", disk: "empty" })).toEqual(plan);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/agents/users%2Falice%2Ftriage/fork",
      "POST /v1/agents/users%2Falice%2Ftriage/fork",
    ]);
    expect(sent[0]!.body).toMatchObject({ id: "users/alice/triage-2", manifest: "triage@4" });
    expect(sent[0]!.body.requestId).toEqual(expect.any(String));
    expect(sent[1]!.body).toEqual({ id: "users/alice/triage-2", disk: "empty", dryRun: true });
  });

  it("snapshots, restores, lists and deletes disk versions, and reads events", async () => {
    const { client, sent } = fake((_method, path) =>
      path.endsWith("/events") ? Response.json({ events: [{ type: "agent.created" }] }) : Response.json({}),
    );
    await client.agents.snapshot("projects/acme");
    await client.agents.restore("projects/acme", 2);
    await client.agents.versions("projects/acme");
    await client.agents.deleteVersion("projects/acme", 1);
    expect(
      await client.agents.events("projects/acme", { from: 3, types: ["agent.egress", "agent.lost"], since: new Date(0) }),
    ).toEqual([{ type: "agent.created" }]);
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /v1/agents/projects%2Facme/snapshot",
      "POST /v1/agents/projects%2Facme/restore",
      "GET /v1/agents/projects%2Facme/versions",
      "DELETE /v1/agents/projects%2Facme/versions/1",
      "GET /v1/agents/projects%2Facme/events",
    ]);
    expect(sent[1]!.body).toMatchObject({ version: 2 });
    const query = new URLSearchParams(sent[4]!.search);
    expect(query.get("from")).toBe("3");
    expect(query.get("types")).toBe("agent.egress,agent.lost");
    expect(query.get("since")).toBe("1970-01-01T00:00:00.000Z");
  });

  it("refuses an id the Runtime would refuse, before sending anything", async () => {
    const { client, sent } = fake();
    await expect(client.agents.put("bad id!", { manifest: "triage" })).rejects.toThrow(TypeError);
    expect(sent).toEqual([]);
  });

  it("opens sessions on an Agent, by an id the app chooses", async () => {
    const { client, sent } = fake();
    const session = await client.createSession({
      id: "inbox-alice",
      agent: "users/alice/triage",
      ownerUserId: "alice",
      info: { plan: "pro" },
    });
    expect(session.id).toBe("inbox-alice");
    expect(sent.map(({ method, path }) => `${method} ${path}`)).toEqual(["PUT /v1/sessions/inbox-alice"]);
    expect(sent[0]!.body).toEqual({
      requestId: expect.any(String),
      agent: "users/alice/triage",
      ownerUserId: "alice",
      info: { plan: "pro" },
    });
  });
});
