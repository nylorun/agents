// A sample credential resolver (SELF_HOSTING.md, "The credential resolver"): the Nylorun gateway
// POSTs { owner, session, turn, target: { kind: "mcp", server, agent, url } } with a shared bearer,
// and this answers with the person's token for that MCP server, read from OpenBao KV v2 at
// secret/data/nylorun/<owner>/<server> (field `token`), or 404 when they have none. No dependencies.
import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";

const env = (name, fallback) => {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const PORT = Number(env("PORT", "8090"));
const TOKEN = env("RESOLVER_TOKEN"); // the gateway's NYLORUN_RESOLVER_TOKEN
const BAO_ADDR = env("BAO_ADDR", "http://openbao:8200").replace(/\/+$/, "");
const BAO_TOKEN = env("BAO_TOKEN"); // a token that may read secret/data/nylorun/*
const SEGMENT = /^[A-Za-z0-9@:._-]{1,200}$/; // one KV path segment: no "/", never "." or ".."

const digest = (value) => createHash("sha256").update(value).digest();
const authorized = (header) => timingSafeEqual(digest(header ?? ""), digest(`Bearer ${TOKEN}`));
const send = (response, status, body) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const segment = (value) => typeof value === "string" && SEGMENT.test(value) && !/^\.+$/.test(value);

async function readBody(request) {
  let text = "";
  for await (const chunk of request) if ((text += chunk).length > 64 * 1024) throw new Error("too large");
  return JSON.parse(text);
}

createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") return send(response, 200, { status: "ok" });
  if (request.method !== "POST" || request.url !== "/") return send(response, 404, { status: "not_found" });
  if (!authorized(request.headers.authorization)) return send(response, 401, { status: "unauthorized" });
  let body;
  try {
    body = await readBody(request);
  } catch {
    return send(response, 400, { status: "bad_request" });
  }
  const { owner, target } = body ?? {};
  if (target?.kind !== "mcp" || !segment(owner)) return send(response, 400, { status: "bad_request" });
  if (!segment(target.server)) return send(response, 404, { status: "not_connected" });
  try {
    const path = ["nylorun", owner, target.server].map(encodeURIComponent).join("/");
    const reply = await fetch(`${BAO_ADDR}/v1/secret/data/${path}`, {
      headers: { "x-vault-token": BAO_TOKEN },
      signal: AbortSignal.timeout(3000),
    });
    if (reply.status === 404) return send(response, 404, { status: "not_connected" });
    if (!reply.ok) throw new Error(`OpenBao answered ${reply.status}`);
    const token = (await reply.json())?.data?.data?.token;
    if (typeof token !== "string" || token === "") return send(response, 404, { status: "not_connected" });
    // Nylorun keeps an answer at most 5 minutes (60 s without expiresAt).
    send(response, 200, { headers: { authorization: `Bearer ${token}` } });
  } catch (error) {
    console.error(`resolver: ${error instanceof Error ? error.message : String(error)}`);
    send(response, 502, { status: "unavailable" }); // the gateway refuses the server: credential_unavailable
  }
}).listen(PORT, () => console.log(`resolver listening on :${PORT}`));
