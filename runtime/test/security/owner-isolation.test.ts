/**
 * Owner enforcement: two subjects on one Tenant never reach each other's sessions, nor attach
 * each other's vaults (vault routes take no subject, protocol 7).
 * Another owner's resource answers exactly what a missing one does, so a subject cannot learn
 * which ids exist. Requests without `Nylorun-Subject` keep today's answers.
 */
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  createSession,
  createVault,
  settle,
  startSubjectTenant,
  type SubjectTenant,
} from "./subjects.js";

const ada = { subject: "app:ada", scopes: ["sessions:own"] } as const;
const bao = { subject: "app:bao", scopes: ["sessions:own"] } as const;

let tenant: SubjectTenant;
let adaVault: { vaultId: string; credentialId: string };
let baoVault: { vaultId: string; credentialId: string };

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
  adaVault = await createVault(tenant, ada);
  baoVault = await createVault(tenant, bao);
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

it("refuses vault routes to a subject, its own vaults included (protocol 7)", async () => {
  const { vaultId, credentialId } = adaVault;
  for (const [method, path] of [
    ["GET", "/v1/vaults"],
    ["GET", `/v1/vaults/${vaultId}`],
    ["GET", `/v1/vaults/${vaultId}/credentials`],
    ["GET", `/v1/vaults/${vaultId}/credentials/${credentialId}`],
    ["DELETE", `/v1/vaults/${vaultId}`],
  ] as const)
    for (const as of [ada, bao]) {
      const reply = await tenant.call(method, path, { as });
      expect(reply.status, `${method} ${path}`).toBe(403);
      expect(reply.body.code).toBe("scope_required");
    }
  expect(
    (await tenant.call("GET", `/v1/vaults?ownerUserId=${ada.subject}`)).body.vaults
  ).toHaveLength(1);
});

it("does not let a session attach another owner's vault or sandbox", async () => {
  const vault = await createSession(tenant, "bao-v", bao, {
    vaultIds: [adaVault.vaultId],
  });
  const missingVault = await createSession(tenant, "bao-v", bao, {
    vaultIds: ["vlt_missing"],
  });
  expect(vault.status).toBe(404);
  expect(vault.text).toBe(missingVault.text);
  const sandbox = await createSession(tenant, "bao-x", bao, {
    sandbox: { session: "ada-s" },
  });
  const missingSandbox = await createSession(tenant, "bao-x", bao, {
    sandbox: { session: "nobody" },
  });
  expect(sandbox.status).toBe(404);
  expect(sandbox.text).toBe(missingSandbox.text);
  // Own vaults still attach.
  const own = await createSession(tenant, "bao-v2", bao, {
    vaultIds: [baoVault.vaultId],
  });
  expect(own.status).toBe(200);
  // Without a subject, the mismatch keeps its 403.
  const operator = await tenant.call("PUT", "/v1/sessions/op-v", {
    body: {
      requestId: "op-v",
      agentId: "bot",
      ownerUserId: bao.subject,
      vaultIds: [adaVault.vaultId],
    },
  });
  expect(operator.status).toBe(403);
});
