import { afterEach, describe, expect, it } from "vitest";
import { Agent, Loop } from "@nylorun/core/define";
import { HOST_PROTOCOL } from "@nylorun/core/compatibility";
import { createActionHandler } from "../src/action-handler.js";
import { AgentsClient } from "../src/client.js";

const APPLICATION_KEY = "a".repeat(64);
const URL = "http://127.0.0.1:8787";
const ENDPOINT = "http://localhost:3000/nylorun/actions";

afterEach(() => {
  delete process.env.NYLORUN_RUNTIME_URL;
  delete process.env.NYLORUN_TENANT;
  delete process.env.NYLORUN_SERVER_KEY;
});

function healthOk() {
  return Response.json({
    status: "ok",
    service: "nylorun-runtime",
    version: "0.9.0-beta",
    protocol: { ...HOST_PROTOCOL },
    coreVersion: "0.4.0-beta",
    hostId: "host_00000000000000000000000001",
    pid: 1,
  });
}

describe("createActionHandler workflows (WF-R3 / WF-C5 / SD-C1)", () => {
  it("saves the workflow plus referenced agents and registers an endpoint for each", async () => {
    const saved: string[] = [];
    let endpoints: { agentId: string; url: string }[] = [];
    const pinged: string[] = [];
    const writer = Agent({ id: "writer", instructions: "Write." }).build();
    const workflow = Loop({
      id: "polish",
      run: writer,
      verify: () => ({ pass: true as const }),
      decide: () => ({ output: "done" }),
    });

    const application = new AgentsClient({
      url: URL,
      key: APPLICATION_KEY,
      fetch: async (url, init) => {
        const path = String(url);
        if (path.endsWith("/health")) return healthOk();
        if (path.includes("/v1/agents/") && init?.method === "PUT") {
          saved.push(decodeURIComponent(path.split("/").pop()!));
          return Response.json({ ok: true });
        }
        if (path.endsWith("/v1/endpoints") && init?.method === "PUT") {
          endpoints = JSON.parse(String(init.body)).endpoints;
          return Response.json({ endpoints: [] });
        }
        if (path.endsWith("/ping")) {
          const agentId = decodeURIComponent(path.split("/").at(-2)!);
          pinged.push(agentId);
          return Response.json({ agentId, implementationVersion: "test" });
        }
        throw new Error(`unexpected ${path}`);
      },
    });

    await createActionHandler({
      agents: [workflow],
      client: application,
      implementationVersion: "test",
    }).register({ url: ENDPOINT });
    expect(new Set(saved)).toEqual(new Set(["polish", "writer"]));
    expect(saved.filter((id) => id === "polish")).toHaveLength(1);
    expect(endpoints.map((e) => [e.agentId, e.url])).toEqual([
      ["polish", ENDPOINT],
      ["writer", ENDPOINT],
    ]);
    expect(pinged).toEqual(["polish", "writer"]);
  });
});
