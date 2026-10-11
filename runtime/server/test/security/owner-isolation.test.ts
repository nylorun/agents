/**
 * Owner enforcement: two subjects on one Tenant never reach each other's sessions, nor open a
 * session on an Environment guarded for the other (its `ownerUserId`, protocol 11).
 * Another owner's resource answers exactly what a missing one does, so a subject cannot learn
 * which ids exist. Requests without `Nylorun-Subject` keep today's answers.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createSession,
  createEnvironment,
  settle,
  startSubjectTenant,
  type SubjectTenant,
} from "./subjects.js";

const ada = { subject: "app:ada", scopes: ["sessions:own"] } as const;
const bao = { subject: "app:bao", scopes: ["sessions:own"] } as const;

let tenant: SubjectTenant;
let adaEnvironment: { environmentId: string; secretName: string };
let baoEnvironment: { environmentId: string; secretName: string };

beforeAll(async () => {
  tenant = await startSubjectTenant();
  expect((await createSession(tenant, "ada-s", ada)).status).toBe(200);
  expect((await createSession(tenant, "bao-s", bao)).status).toBe(200);
  const turn = await tenant.call("POST", "/v1/sessions/ada-s/commands", {
    as: ada,
    body: { requestId: "m1", idempotencyKey: "m1", type: "message", content: "hi" },
  });
  expect(turn.status).toBe(200);
  await settle(tenant, "ada-s");
  adaEnvironment = await createEnvironment(tenant, ada);
  baoEnvironment = await createEnvironment(tenant, bao);
});
afterAll(async () => {
  await tenant.close();
});

const ids = (reply: { body: { sessions: { id: string }[] } }) =>
  reply.body.sessions.map((s) => s.id).sort();

it("lists only the subject's own sessions", async () => {
  expect(ids(await tenant.call("GET", "/v1/sessions", { as: ada }))).toEqual(["ada-s"]);
  expect(ids(await tenant.call("GET", "/v1/sessions", { as: bao }))).toEqual(["bao-s"]);
  expect(
    ids(await tenant.call("GET", "/v1/sessions?agentId=bot", { as: bao }))
  ).toEqual(["bao-s"]);
  expect(ids(await tenant.call("GET", "/v1/sessions"))).toEqual(["ada-s", "bao-s"]);
});

it("answers another owner's session exactly as a missing one", async () => {
  for (const suffix of ["", "/items", "/events"]) {
    const other = await tenant.call("GET", `/v1/sessions/ada-s${suffix}`, { as: bao });
    const missing = await tenant.call("GET", `/v1/sessions/nobody${suffix}`, { as: bao });
    expect(other.status, suffix).toBe(404);
    expect(other.text, suffix).toBe(missing.text);
  }
  expect((await tenant.call("GET", "/v1/sessions/ada-s", { as: ada })).status).toBe(200);
  expect((await tenant.call("GET", "/v1/sessions/ada-s/items", { as: ada })).status).toBe(200);
});

it("opens the event stream for the owner only", async () => {
  const abort = new AbortController();
  const response = await fetch(`${tenant.runtime.url}/v1/sessions/ada-s/events`, {
    headers: {
      authorization: `Bearer ${tenant.runtime.applicationKey}`,
      "Nylorun-Subject": ada.subject,
      "Nylorun-Scopes": ada.scopes.join(" "),
    },
    signal: abort.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  abort.abort();
  await response.body?.cancel().catch(() => undefined);
});

it("refuses every command on another owner's session without acting on it", async () => {
  const before = await tenant.call("GET", "/v1/sessions/ada-s/items", { as: ada });
  const commands = [
    { type: "message", content: "take over" },
    { type: "approve", interactionId: "i1", approved: true },
    { type: "respond", interactionId: "i1", value: "yes" },
    { type: "cancel" },
  ];
  for (const [index, command] of commands.entries()) {
    const key = `bao-${index}`;
    const other = await tenant.call("POST", "/v1/sessions/ada-s/commands", {
      as: bao,
      body: { requestId: key, idempotencyKey: key, ...command },
    });
    const missing = await tenant.call("POST", "/v1/sessions/nobody/commands", {
      as: bao,
      body: { requestId: key, idempotencyKey: key, ...command },
    });
    expect(other.status, command.type).toBe(404);
    expect(other.text, command.type).toBe(missing.text);
  }
  const after = await tenant.call("GET", "/v1/sessions/ada-s/items", { as: ada });
  expect(after.body.items.length).toBe(before.body.items.length);
  expect((await tenant.call("GET", "/v1/sessions/ada-s")).body.status).toBe("completed");
});

it("answers PUT on another owner's session id with 404, not 409", async () => {
  const taken = await createSession(tenant, "ada-s", bao);
  const fresh = await createSession(tenant, "never-made", { ...bao, subject: "app:x" });
  expect(taken.status).toBe(404);
  expect(taken.text).toBe(
    (await tenant.call("GET", "/v1/sessions/nobody", { as: bao })).text
  );
  expect(fresh.status).toBe(200);
  // Naming someone else as the owner is refused before any lookup.
  const forged = await tenant.call("PUT", "/v1/sessions/forged", {
    as: bao,
    body: { requestId: "forged", agentId: "bot", ownerUserId: ada.subject },
  });
  expect(forged.status).toBe(403);
  expect((await tenant.call("GET", "/v1/sessions/forged")).status).toBe(404);
  // Without a subject, a mismatch is still the 409 it was.
  const mismatch = await tenant.call("PUT", "/v1/sessions/ada-s", {
    body: { requestId: "again", agentId: "bot", ownerUserId: bao.subject },
  });
  expect(mismatch.status).toBe(409);
});

it("refuses secret writes to a subject without environments:write, its own Environment included", async () => {
  const { environmentId, secretName } = adaEnvironment;
  const body = { requestId: "steal", type: "bearer", url: "https://mcp.example.com/tools", value: "mine" };
  for (const [method, path, sent] of [
    ["PUT", `/v1/environments/${environmentId}/secrets/${secretName}`, body],
    ["DELETE", `/v1/environments/${environmentId}/secrets/${secretName}`, undefined],
    ["PUT", `/v1/environments/${environmentId}`, { requestId: "take", ownerUserId: null }],
    ["DELETE", `/v1/environments/${environmentId}`, undefined],
  ] as const)
    for (const as of [ada, bao]) {
      const reply = await tenant.call(method, path, { as, ...(sent ? { body: sent } : {}) });
      expect(reply.status, `${method} ${path}`).toBe(403);
    }
  // Nothing changed: the guard and the secret are still there.
  const view = await tenant.call("GET", `/v1/environments/${environmentId}`);
  expect(view.body.ownerUserId).toBe(ada.subject);
  expect(
    (await tenant.call("GET", `/v1/environments/${environmentId}/secrets`)).body.secrets.map(
      (secret: { name: string }) => secret.name
    )
  ).toEqual([secretName]);
  // A subject sees only its own sessions on an Environment.
  expect((await tenant.call("GET", `/v1/environments/${environmentId}`, { as: bao })).body.sessions).toEqual([]);
});

it("refuses the Management API to a subject (protocol 8)", async () => {
  for (const [method, path, body] of [
    ["POST", "/v1/tenant/credential-coverage", { agentId: "bot", environmentId: adaEnvironment.environmentId }],
    ["POST", "/v1/tenant/mcp/preview", { url: "https://mcp.example.com/tools", environmentId: adaEnvironment.environmentId }],
    ["GET", "/v1/tenant", undefined],
  ] as const)
    for (const as of [ada, bao]) {
      // The Management API takes no application key, acting for a subject or not.
      const reply = await tenant.call(method, path, { as, ...(body ? { body } : {}) });
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body.code).toBe("key_role_mismatch");
      // Nor a management key acting for one.
      const managed = await tenant.call(method, path, {
        as,
        key: tenant.runtime.managementKey,
        ...(body ? { body } : {}),
      });
      expect(managed.status, `${method} ${path}`).toBe(403);
      expect(managed.body.code).toBe("subject_invalid");
    }
});

it("does not let a session name an Environment guarded for another owner", async () => {
  const other = await createSession(tenant, "bao-v", bao, {
    environment: adaEnvironment.environmentId,
  });
  const missing = await createSession(tenant, "bao-v", bao, {
    environment: "env-missing",
  });
  // Acting for a person: exactly the 404 of a missing Environment.
  expect(other.status).toBe(404);
  expect(other.text).toBe(missing.text);
  expect((await tenant.call("GET", "/v1/sessions/bao-v")).status).toBe(404);
  // Its own Environment opens.
  const own = await createSession(tenant, "bao-v2", bao, {
    environment: baoEnvironment.environmentId,
  });
  expect(own.status).toBe(200);
  expect(own.body.environment).toEqual({ id: baoEnvironment.environmentId, version: 1 });
  // Without a subject, the mismatch is a 403 that names it.
  const operator = await tenant.call("PUT", "/v1/sessions/op-v", {
    body: {
      requestId: "op-v",
      agentId: "bot",
      ownerUserId: bao.subject,
      environment: adaEnvironment.environmentId,
    },
  });
  expect(operator.status).toBe(403);
  expect(operator.body.code).toBe("environment_owner_mismatch");
  // The removed fields are refused, not ignored (protocol 11).
  for (const extra of [
    { vaultIds: ["vlt_x"] },
    { sandbox: { session: "ada-s" } },
    { credentialSelections: {} },
  ]) {
    const refused = await createSession(tenant, "bao-x", bao, extra);
    expect(refused.status, JSON.stringify(extra)).toBe(400);
  }
});

it("refuses a turn when the Environment's guard moves to another owner", async () => {
  const environmentId = "env-moved";
  await createEnvironment(tenant, bao, { id: environmentId });
  expect(
    (await createSession(tenant, "bao-moved", bao, { environment: environmentId })).status
  ).toBe(200);
  const moved = await tenant.call("PUT", `/v1/environments/${environmentId}`, {
    body: { requestId: "move", ownerUserId: ada.subject },
  });
  expect(moved.status).toBe(200);
  const turn = await tenant.call("POST", "/v1/sessions/bao-moved/commands", {
    as: bao,
    body: { requestId: "m-moved", idempotencyKey: "m-moved", type: "message", content: "hi" },
  });
  expect(turn.status).toBe(403);
  expect(turn.body.code).toBe("environment_owner_mismatch");
});
