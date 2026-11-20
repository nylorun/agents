import assert from "node:assert/strict";
import test from "node:test";
import { parseMetricsSources, parsePrometheus, readMetrics } from "../src/metrics.ts";
import { counters, familyOf, formatSeconds, histograms, perMinute, quantile, summarize } from "../web/src/traffic.ts";

const RUNTIME = `# HELP http_server_request_duration Duration of HTTP server requests.
# TYPE http_server_request_duration histogram
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="202",nylorun_client="sdk",le="0.1"} 8
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="202",nylorun_client="sdk",le="1"} 10
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="202",nylorun_client="sdk",le="+Inf"} 10
http_server_request_duration_count{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="202",nylorun_client="sdk"} 10
http_server_request_duration_sum{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="202",nylorun_client="sdk"} 0.9
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="503",nylorun_client="studio",le="0.1"} 0
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="503",nylorun_client="studio",le="1"} 2
http_server_request_duration_bucket{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="503",nylorun_client="studio",le="+Inf"} 2
http_server_request_duration_count{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="503",nylorun_client="studio"} 2
http_server_request_duration_sum{http_request_method="POST",http_route="/v1/sessions/{sessionId}/commands",http_response_status_code="503",nylorun_client="studio"} 1.2
gen_ai_invoke_agent_duration_bucket{gen_ai_agent_name="bot",le="10"} 1
gen_ai_invoke_agent_duration_bucket{gen_ai_agent_name="bot",le="60"} 3
gen_ai_invoke_agent_duration_bucket{gen_ai_agent_name="bot",le="+Inf"} 3
gen_ai_invoke_agent_duration_count{gen_ai_agent_name="bot"} 3
gen_ai_invoke_agent_duration_sum{gen_ai_agent_name="bot"} 70
nylorun_telemetry_dropped_total{signal="traces",exporter="otlp"} 4
process_cpu_seconds_total 12
`;
const GATEWAY = `gen_ai_client_inference_duration_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash",le="1"} 1
gen_ai_client_inference_duration_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash",le="5"} 4
gen_ai_client_inference_duration_bucket{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash",le="+Inf"} 4
gen_ai_client_inference_duration_count{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash"} 4
gen_ai_client_inference_duration_sum{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash"} 9
gen_ai_client_inference_duration_count{gen_ai_operation_name="chat",gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash",error_type="rate_limited"} 1
gen_ai_client_inference_usage_input_tokens_total{gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash"} 12000
gen_ai_client_inference_usage_output_tokens_total{gen_ai_provider_name="google-vertex",gen_ai_request_model="gemini-3.8-flash"} 800
mcp_client_operation_duration_count{mcp_method_name="tools/call",gen_ai_tool_name="run_query"} 2
mcp_client_operation_duration_sum{mcp_method_name="tools/call",gen_ai_tool_name="run_query"} 3
nylorun_egress_connections_total{nylorun_egress_outcome="allowed",nylorun_egress_reason=""} 5
nylorun_egress_connections_total{nylorun_egress_outcome="refused",nylorun_egress_reason="host_not_allowed"} 1
nylorun_egress_bytes_total{network_io_direction="receive"} 2048
nylorun_egress_bytes_total{network_io_direction="transmit"} 512
`;
const read = {
  at: "2026-11-20T10:00:00.000Z",
  sources: [
    { name: "runtime", ok: true, samples: parsePrometheus(RUNTIME) },
    { name: "gateway", ok: true, samples: parsePrometheus(GATEWAY) },
  ],
};

test("NYLORUN_STUDIO_METRICS_URLS is name=url pairs, http(s) only, each name once", () => {
  assert.deepEqual(parseMetricsSources(""), []);
  assert.deepEqual(parseMetricsSources(" runtime=http://runtime:9464/metrics , gateway=http://gateway:9464/metrics"), [
    { name: "runtime", url: "http://runtime:9464/metrics" },
    { name: "gateway", url: "http://gateway:9464/metrics" },
  ]);
  assert.throws(() => parseMetricsSources("http://runtime:9464/metrics"), /name=url/);
  assert.throws(() => parseMetricsSources("runtime=file:///etc/passwd"), /http/);
  assert.throws(() => parseMetricsSources("a=http://x/metrics,a=http://y/metrics"), /twice/);
});

test("the Prometheus text keeps the Runtime's families and their labels, nothing else", () => {
  const samples = parsePrometheus(RUNTIME);
  assert.equal(samples.some((s) => s.name === "process_cpu_seconds_total"), false);
  const first = samples[0];
  assert.equal(first.name, "http_server_request_duration_bucket");
  assert.equal(first.labels.http_route, "/v1/sessions/{sessionId}/commands");
  assert.equal(first.labels.nylorun_client, "sdk");
  assert.equal(samples.find((s) => s.labels.le === "+Inf").value, 10);
  assert.deepEqual(parsePrometheus('nylorun_x_total{a="q\\"uote"} 1'), [{ name: "nylorun_x_total", labels: { a: 'q"uote' }, value: 1 }]);
});

test("a source that fails says why, and the others still read", async () => {
  const fetcher = async (url) =>
    url.includes("gateway") ? new Response("", { status: 503 }) : new Response(RUNTIME, { status: 200 });
  const result = await readMetrics(
    [
      { name: "runtime", url: "http://runtime:9464/metrics" },
      { name: "gateway", url: "http://gateway:9464/metrics" },
    ],
    { fetcher, now: () => new Date("2026-11-20T10:00:00Z") },
  );
  assert.equal(result.at, "2026-11-20T10:00:00.000Z");
  assert.equal(result.sources[0].ok, true);
  assert.ok(result.sources[0].samples.length > 0);
  assert.deepEqual(result.sources[1], { name: "gateway", ok: false, error: "HTTP 503", samples: [] });
});

test("families, histograms summed over other labels, and quantiles from buckets", () => {
  assert.equal(familyOf("http_server_request_duration_bucket"), "http_server_request_duration");
  assert.equal(familyOf("nylorun_egress_connections_total"), "nylorun_egress_connections");
  const byRoute = histograms(read, "http_server_request_duration", ["http_route"]);
  const commands = [...byRoute.values()][0];
  assert.equal(commands.count, 12);
  assert.deepEqual(commands.buckets, [[0.1, 8], [1, 12], [Infinity, 12]]);
  assert.equal(quantile(commands, 0.5), 0.1 * (6 / 8));
  assert.ok(Math.abs(quantile(commands, 0.95) - (0.1 + 0.9 * ((11.4 - 8) / 4))) < 1e-9);
  assert.equal(quantile({ buckets: [], count: 0 }, 0.5), undefined);
  assert.equal(counters(read, "nylorun_telemetry_dropped", []).get("").value, 4);
});

test("the Traffic summary: routes, clients, models with tokens and errors, tools, turns, egress", () => {
  const s = summarize(read);
  assert.deepEqual(s.requests.map((r) => [r.label, r.count, r.errors]), [["POST /v1/sessions/{sessionId}/commands", 12, 2]]);
  assert.deepEqual(s.clients, [{ client: "sdk", count: 10 }, { client: "studio", count: 2 }]);
  assert.equal(s.models[0].label, "gemini-3.8-flash");
  assert.equal(s.models[0].detail, "google-vertex");
  assert.equal(s.models[0].count, 5);
  assert.equal(s.models[0].errors, 1);
  assert.equal(s.models[0].extra, "12,000 in, 800 out");
  assert.deepEqual(s.tools.map((t) => [t.label, t.count]), [["run_query", 2]]);
  assert.deepEqual(s.turns.map((t) => [t.label, t.count]), [["bot", 3]]);
  assert.deepEqual(s.egress, [
    { outcome: "allowed", reason: "", count: 5 },
    { outcome: "refused", reason: "host_not_allowed", count: 1 },
  ]);
  assert.deepEqual(s.egressBytes.sort((a, b) => a.direction.localeCompare(b.direction)), [
    { direction: "receive", bytes: 2048 },
    { direction: "transmit", bytes: 512 },
  ]);
  assert.equal(s.dropped, 4);
});

test("rates need two reads, and a restart is no rate", () => {
  assert.equal(perMinute(undefined, 10, 10), undefined);
  assert.equal(perMinute(10, 20, 10), 60);
  assert.equal(perMinute(20, 5, 10), undefined);
  assert.equal(formatSeconds(undefined), "—");
  assert.equal(formatSeconds(0.25), "250 ms");
  assert.equal(formatSeconds(3.21), "3.2 s");
});
