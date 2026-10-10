/** `node:http` and Express adapter for a fetch-style handler. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

export function toNodeListener(handler: {
  readonly fetch: (request: Request) => Promise<Response>;
}): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void (async () => {
      // A closed connection aborts the request, which stops the read, never the turn.
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const host = req.headers.host ?? "localhost";
      const url = new URL(req.url ?? "/", `http://${host}`);
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        for (const item of Array.isArray(value) ? value : [value])
          headers.append(name, item);
      }
      const hasBody = req.method !== "GET" && req.method !== "HEAD";
      const request = new Request(url, {
        method: req.method,
        headers,
        signal: controller.signal,
        ...(hasBody
          ? {
              body: Readable.toWeb(req) as ReadableStream<Uint8Array>,
              duplex: "half",
            }
          : {}),
      } as RequestInit);
      let response: Response;
      try {
        response = await handler.fetch(request);
      } catch {
        response = new Response(JSON.stringify({ error: "Internal error" }), {
          status: 500,
          headers: { "content-type": "application/json" },
        });
      }
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (!response.body) {
        res.end();
        return;
      }
      res.flushHeaders();
      const body = Readable.fromWeb(
        response.body as import("node:stream/web").ReadableStream<Uint8Array>
      );
      body.on("error", () => res.destroy());
      res.on("close", () => body.destroy());
      body.pipe(res);
    })();
  };
}
