/**
 * A stub OpenAI-compatible model for the stack smokes, run with `node -e` in the Runtime image
 * on the Tenant's Compose network (`startStubModel`). The Tenant's model is pointed at it
 * (`PUT /v1/tenant/model`, provider `custom`), so no test hook is needed in the Runtime.
 *
 * Scripted by the user's message: `call <tool> <json arguments>` answers with that tool call
 * while the request offers the tool and no tool result came back yet; a tool result is answered
 * `done: <result>`; anything else `stub answer`. With hold on (`POST /hold`, or `hold: true` at
 * start) every answer but a tool call waits until `POST /release`. `GET /calls` counts calls,
 * held answers and answers whose request was closed before it was answered (`aborted`).
 */
import { run } from "./repo.mjs";

export const STUB_MODEL = String.raw`
const http = require("node:http");
let calls = 0;
let aborted = 0;
let hold = process.env.STUB_HOLD === "1";
const held = new Set();
const base = { id: "stub", object: "chat.completion.chunk", created: 0, model: "stub" };
function stream(res, delta, finish) {
  const chunk = (body) => res.write("data: " + JSON.stringify({ ...base, ...body }) + "\n\n");
  res.writeHead(200, { "content-type": "text/event-stream" });
  chunk({ choices: [{ index: 0, delta: { role: "assistant", ...delta }, finish_reason: null }] });
  chunk({ choices: [{ index: 0, delta: {}, finish_reason: finish }] });
  chunk({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } });
  res.end("data: [DONE]\n\n");
}
const text = (content) =>
  typeof content === "string"
    ? content
    : (content ?? []).map((part) => (typeof part === "string" ? part : part.text ?? "")).join("");
http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/calls") {
    res.setHeader("content-type", "application/json");
    return res.end(JSON.stringify({ calls, held: held.size, aborted }));
  }
  if (req.method === "POST" && req.url === "/hold") {
    hold = true;
    return res.end("{}");
  }
  if (req.method === "POST" && req.url === "/release") {
    hold = false;
    for (const answer of held) answer();
    held.clear();
    return res.end("{}");
  }
  if (req.method === "POST" && req.url.endsWith("/chat/completions")) {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      calls += 1;
      const body = JSON.parse(raw || "{}");
      const messages = body.messages ?? [];
      const last = messages.at(-1);
      const user = [...messages].reverse().find((message) => message.role === "user");
      const script = /^call (\S+) ([\s\S]*)$/.exec(text(user?.content).trim());
      const offered = (name) => (body.tools ?? []).some((tool) => tool.function?.name === name);
      if (last?.role !== "tool" && script && offered(script[1]))
        return stream(
          res,
          { tool_calls: [{ index: 0, id: "call_" + calls, type: "function", function: { name: script[1], arguments: script[2] } }] },
          "tool_calls",
        );
      const answer = () =>
        stream(res, { content: last?.role === "tool" ? "done: " + text(last.content) : "stub answer" }, "stop");
      if (!hold) return answer();
      held.add(answer);
      // Closed before it was answered: the caller (the gateway) aborted it.
      res.on("close", () => {
        if (held.delete(answer)) aborted += 1;
      });
    });
    return;
  }
  res.statusCode = 404;
  res.end();
}).listen(8080, "0.0.0.0");
`;

export const STUB_ALIAS = "stub-model";

const docker = (args) => run("docker", args, { capture: true, timeout: 120_000 });

/**
 * Starts the stub on the Tenant's default network (named after its Compose project) as
 * `stub-model`, published on a loopback port for its counters. Returns its URL from this
 * machine, `stats()`, `hold()`, `release()`, and `remove()`.
 */
export async function startStubModel(stack, image, { hold = false } = {}) {
  const name = `${stack.project}-${STUB_ALIAS}`;
  await docker([
    "run", "--detach", "--rm",
    "--name", name,
    "--network", stack.project,
    "--network-alias", STUB_ALIAS,
    "--publish", "127.0.0.1::8080",
    "--env", `STUB_HOLD=${hold ? "1" : "0"}`,
    "--entrypoint", "node",
    image,
    "-e", STUB_MODEL,
  ]);
  const published = (await docker(["port", name, "8080/tcp"])).split("\n")[0].trim();
  const url = `http://${published}`;
  const stub = {
    name,
    url,
    /** The Tenant's model setting for this stub. */
    model: {
      provider: "custom",
      model: "stub",
      baseUrl: `http://${STUB_ALIAS}:8080/v1`,
      // The stub ignores it; the custom provider needs a key.
      auth: { type: "api_key", key: "stub-model-key" },
    },
    stats: async () => (await fetch(`${url}/calls`)).json(),
    hold: () => fetch(`${url}/hold`, { method: "POST" }),
    release: () => fetch(`${url}/release`, { method: "POST" }),
    remove: () => docker(["rm", "--force", name]).catch(() => {}),
  };
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await stub.stats();
      return stub;
    } catch (error) {
      if (Date.now() > deadline) throw new Error(`The stub model did not answer: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
