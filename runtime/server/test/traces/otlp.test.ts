/** OTLP/HTTP JSON (R7.2): the encoder, and a poster that retries, then drops and says so. */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { GENAI_SEMCONV, SPAN_KIND, type OtlpSpan } from "../../src/traces/map.js";
import { createOtlpPoster, resourceSpans } from "../../src/traces/otlp.js";

const span: OtlpSpan = {
  traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
  spanId: "00f067aa0ba902b7",
  parentSpanId: "53995c3f42cd8ad8",
  name: "chat m",
  kind: SPAN_KIND.client,
  startTimeUnixNano: "1791796440120000000",
  endTimeUnixNano: "1791796442840000000",
  attributes: [{ key: "gen_ai.operation.name", value: { stringValue: "chat" } }],
  status: { code: 1 },
};

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

/** A collector answering each request with the next status of `statuses` (the last repeats). */
async function collector(statuses: number[]) {
  const requests: { headers: Record<string, unknown>; body: any }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    requests.push({ headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString()) });
    res.writeHead(statuses[Math.min(requests.length - 1, statuses.length - 1)]!).end("{}");
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/traces`, requests };
}

describe("OTLP/HTTP JSON", () => {
  it("encodes one resource with its service name, attributes and the pinned conventions", () => {
    const body = resourceSpans({ serviceName: "acme", attributes: { "deployment.environment": "prod", "service.name": "ignored" } }, [span]);
    expect(body.resourceSpans).toHaveLength(1);
    expect(body.resourceSpans[0]!.resource.attributes).toEqual([
      { key: "service.name", value: { stringValue: "acme" } },
      { key: "deployment.environment", value: { stringValue: "prod" } },
      { key: "nylorun.semconv.genai", value: { stringValue: GENAI_SEMCONV } },
    ]);
    const [scope] = body.resourceSpans[0]!.scopeSpans;
    expect(scope!.scope.name).toBe("@nylorun/runtime");
    expect(scope!.spans).toEqual([span]);
    // OTLP/JSON: hex ids, times and integers as decimal strings.
    expect(JSON.parse(JSON.stringify(body)).resourceSpans[0].scopeSpans[0].spans[0].startTimeUnixNano).toBe("1791796440120000000");
  });

  it("posts with the configured headers, and retries a 429 or a 5xx", async () => {
    const target = await collector([503, 429, 200]);
    const post = createOtlpPoster({ url: target.url, headers: { authorization: "Bearer x" }, resource: { serviceName: "nylorun" }, backoffMs: 5 });
    expect(await post([span])).toBe("posted");
    expect(target.requests).toHaveLength(3);
    expect(target.requests[0]!.headers).toMatchObject({ authorization: "Bearer x", "content-type": "application/json" });
    expect(target.requests[2]!.body.resourceSpans[0].scopeSpans[0].spans).toEqual([span]);
  });

  it("drops a batch after three retries, logs it, and resolves", async () => {
    const target = await collector([500]);
    const logged: unknown[] = [];
    const post = createOtlpPoster({
      url: target.url,
      resource: { serviceName: "nylorun" },
      backoffMs: 5,
      log: (message, fields) => logged.push({ message, ...fields }),
    });
    expect(await post([span, span])).toBe("dropped");
    expect(target.requests).toHaveLength(4);
    expect(logged).toEqual([{ message: "trace_export_dropped", spans: 2, reason: "HTTP 500" }]);
  });

  it("drops at once on another refusal, and on a collector that is not there after its retries", async () => {
    const target = await collector([400]);
    const post = createOtlpPoster({ url: target.url, resource: { serviceName: "nylorun" }, backoffMs: 5 });
    expect(await post([span])).toBe("dropped");
    expect(target.requests).toHaveLength(1);
    const dead = createOtlpPoster({ url: "http://127.0.0.1:1/v1/traces", resource: { serviceName: "nylorun" }, backoffMs: 5 });
    expect(await dead([span])).toBe("dropped");
  });
});
