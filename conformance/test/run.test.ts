/**
 * The runner and the command line, against a fake Runtime: which checks run, which are skipped
 * or not applicable, the protocol header every request names, and the exit codes.
 */
import { describe, expect, it } from "vitest";
import { main, parseCommandLine } from "../src/cli.js";
import { jsonLine } from "../src/report.js";
import { runConformance } from "../src/run.js";

/** A Runtime that answers `/health` and refuses the rest with `status`, recording each request. */
function fakeRuntime(status = 503) {
  const requests: { method: string; url: string; headers: Record<string, string> }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      method: init?.method ?? "GET",
      url,
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    if (url.endsWith("/health"))
      return new Response(
        JSON.stringify({ status: "ok", protocol: { min: 11, max: 11, features: [] } }),
        { status: 200 },
      );
    return new Response(
      JSON.stringify({ status: "rejected", code: "unavailable", message: "down" }),
      { status },
    );
  }) as typeof globalThis.fetch;
  return { fetch, requests };
}

const base = {
  runtime: "http://runtime.test/",
  key: "app",
  manageKey: "manage",
  harness: "acme-mini",
};

describe("runConformance", () => {
  it("fails every check that applies when setup fails, and skips or excuses the rest", async () => {
    const runtime = fakeRuntime();
    const seen: string[] = [];
    const report = await runConformance({
      ...base,
      fetch: runtime.fetch,
      onResult: (result) => seen.push(result.id),
    });
    expect(report.ok).toBe(false);
    expect(seen).toHaveLength(19);
    const status = Object.fromEntries(report.results.map((result) => [result.id, result.status]));
    expect(status).toMatchObject({
      HC01: "fail",
      HC07: "skipped",
      HC08: "skipped",
      HC10: "skipped",
      HC15: "n/a",
      HC16: "n/a",
      HC17: "n/a",
      HC19: "fail",
    });
    expect(report.results.find((result) => result.id === "HC01")?.detail).toMatch(
      /^setup failed: PUT \/v1\/tenant\/config\/seed answered 503/,
    );
    // The fixture model's seed uses the management key; every request names the Runtime's protocol.
    const seed = runtime.requests.find((request) =>
      request.url.endsWith("/v1/tenant/config/seed"),
    )!;
    expect(seed.headers).toMatchObject({
      authorization: "Bearer manage",
      "nylorun-protocol": "11",
    });
    expect(seed.url).toBe("http://runtime.test/v1/tenant/config/seed");
  });

  it("runs only the checks asked for, and refuses a harness id that is not one", async () => {
    const report = await runConformance({
      ...base,
      fetch: fakeRuntime().fetch,
      only: ["HC03", "HC16"],
    });
    expect(report.results.map((result) => [result.id, result.status])).toEqual([
      ["HC03", "fail"],
      ["HC16", "n/a"],
    ]);
    await expect(runConformance({ ...base, harness: "Acme Mini" })).rejects.toThrow(
      "not a harness id",
    );
    await expect(runConformance({ ...base, profile: "pod" })).rejects.toThrow("needs --image");
  });

  it("prints one JSON line per check with id, ok, detail and section", async () => {
    const [result] = (await runConformance({ ...base, fetch: fakeRuntime().fetch, only: ["HC10"] }))
      .results;
    expect(JSON.parse(jsonLine(result!))).toMatchObject({
      id: "HC10",
      ok: true,
      status: "skipped",
      section: "§2, §5",
      detail: expect.any(String),
    });
  });
});

describe("the pod profile", () => {
  it("runs every session in one pod Environment whose image is the harness", async () => {
    const puts: { url: string; body: unknown }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/health"))
        return new Response(JSON.stringify({ protocol: { min: 11, max: 11 } }), { status: 200 });
      if (init?.method === "PUT") {
        puts.push({ url, body: JSON.parse(String(init.body)) });
        return new Response(JSON.stringify({ applied: [], kept: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ code: "unavailable" }), { status: 503 });
    }) as typeof globalThis.fetch;
    const report = await runConformance({
      ...base,
      fetch,
      profile: "pod",
      image: "ghcr.io/acme/mini:1",
      prefix: "hc-test",
      only: ["HC03", "HC15"],
    });
    expect(report.results.map((result) => result.status)).toEqual(["fail", "fail"]);
    const environments = puts.filter((put) => put.url.includes("/v1/environments/"));
    expect(environments).toEqual([
      {
        url: "http://runtime.test/v1/environments/hc-test-pod",
        body: { kind: "pod", harness: "acme-mini", image: "ghcr.io/acme/mini:1" },
      },
    ]);
    expect(
      puts
        .filter((put) => put.url.includes("/v1/sessions/"))
        .map((put) => (put.body as { environment: string }).environment),
    ).toEqual(["hc-test-pod", "hc-test-pod"]);
  });
});

describe("command line", () => {
  it("reads the options and the environment", () => {
    const { options, json } = parseCommandLine(
      [
        "--harness",
        "acme-mini",
        "--profile",
        "pod",
        "--image",
        "ghcr.io/acme/mini:1",
        "--restart",
        "docker restart acme",
        "--long",
        "--json",
        "--secret",
        "s1",
        "--secret",
        "s2",
        "--only",
        "hc01,HC15",
      ],
      {
        NYLORUN_RUNTIME_URL: "http://localhost:4000",
        NYLORUN_API_KEY: "app",
        NYLORUN_MANAGEMENT_KEY: "manage",
      },
    );
    expect(json).toBe(true);
    expect(options).toMatchObject({
      runtime: "http://localhost:4000",
      key: "app",
      manageKey: "manage",
      harness: "acme-mini",
      profile: "pod",
      image: "ghcr.io/acme/mini:1",
      restart: "docker restart acme",
      long: true,
      secrets: ["s1", "s2"],
      only: ["HC01", "HC15"],
    });
  });

  it("refuses what it cannot run", () => {
    expect(() => parseCommandLine(["--harness", "x1"], {})).toThrow(
      "Missing --runtime, --key, --manage-key",
    );
    const env = { NYLORUN_RUNTIME_URL: "u", NYLORUN_API_KEY: "k", NYLORUN_MANAGEMENT_KEY: "m" };
    expect(() => parseCommandLine(["--harness", "x1", "--profile", "pod"], env)).toThrow(
      "needs --image",
    );
    expect(() => parseCommandLine(["--harness", "x1", "--mcp-url", "http://mcp"], env)).toThrow(
      "go together",
    );
    expect(() => parseCommandLine(["--harness", "x1", "--only", "HC99"], env)).toThrow(
      "Unknown checks: HC99",
    );
  });

  it("exits 2 on a usage error, 0 for help, 1 when a check fails", async () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      await main(
        ["--bogus"],
        {},
        (line) => out.push(line),
        (line) => err.push(line),
      ),
    ).toBe(2);
    expect(err.join("\n")).toContain("Usage: nylorun-harness-conformance");
    expect(
      await main(
        ["--help"],
        {},
        (line) => out.push(line),
        (line) => err.push(line),
      ),
    ).toBe(0);
    // An unreachable Runtime: setup fails, so the required checks fail.
    const env = {
      NYLORUN_RUNTIME_URL: "http://127.0.0.1:9",
      NYLORUN_API_KEY: "k",
      NYLORUN_MANAGEMENT_KEY: "m",
    };
    const lines: string[] = [];
    expect(
      await main(
        ["--harness", "acme-mini", "--json", "--only", "HC01"],
        env,
        (line) => lines.push(line),
        () => undefined,
      ),
    ).toBe(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ id: "HC01", ok: false, status: "fail" });
  });
});
