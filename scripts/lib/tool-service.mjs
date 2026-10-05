/**
 * A tool service for the acceptance scripts: the code behind `http()` tools, which the Runtime
 * calls itself (it runs no code of the developer's during a session). Each tool is one path,
 * `POST /<name>`, answered by its handler with JSON; every call is counted. On a local Tenant
 * the Runtime runs in Docker and maps `localhost` to this machine, so the server listens on
 * every interface.
 */
import { createServer } from "node:http";
import { http } from "@nylorun/agents";

/**
 * @param {Record<string, (input: any) => unknown>} handlers one per tool name
 * @param {{ port?: number, host?: string }} [options] `port` 0 (default) picks a free one;
 *   `host` is the name the Runtime reaches this machine by (default `localhost`)
 */
export async function startToolService(handlers, options = {}) {
  const calls = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const name = decodeURIComponent(new URL(request.url ?? "/", "http://x").pathname.slice(1));
    const handler = handlers[name];
    if (request.method !== "POST" || !handler) return void response.writeHead(404).end(`no tool ${name}`);
    try {
      const text = Buffer.concat(chunks).toString();
      const input = text ? JSON.parse(text) : undefined;
      calls.push({ name, input });
      const output = await handler(input);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(output ?? null));
    } catch (error) {
      response.writeHead(500, { "content-type": "text/plain" }).end(String(error));
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, resolve);
  });
  const base = `http://${options.host ?? "localhost"}:${server.address().port}`;
  return {
    base,
    /** Every call, in order. */
    calls,
    /**
     * An `http()` tool for `name` at this service.
     * @param {string} name
     * @param {Omit<Parameters<typeof http>[0], "name" | "url">} tool
     * @param {string} [url] where the Runtime reaches the tool, when not at this service's own URL (a tunnel)
     */
    tool: (name, tool, url = `${base}/${encodeURIComponent(name)}`) => http({ name, ...tool, url }),
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
