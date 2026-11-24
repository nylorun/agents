/**
 * The computer's contract: the cases in
 * `sandboxes/internal/computer/testdata/contract.json`, against the engine's `--service computer`
 * routes (`computerHandler` on the local backend, real processes in a temporary workspace). The
 * computer agent runs the same file in Go (`sandboxes/internal/computer/contract_test.go`), so
 * both answer the same.
 */
import { accessSync, constants, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { localBackend } from "../../src/adapters/sandbox/local.js";
import { computerHandler } from "../../src/harness/computer.js";
import { TRUST_VARIABLES } from "../../src/harness/pod.js";
import { baselineEnvironment } from "../../src/host/environment.js";

interface Step {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly ticket?: string;
    readonly body?: unknown;
    readonly bodyText?: string;
  };
  readonly expect: {
    readonly status: number;
    readonly contentType?: string;
    readonly json?: unknown;
    readonly text?: string;
  };
}

interface Contract {
  readonly name: string;
  readonly harnessRoot: string;
  readonly processEnv: Record<string, string>;
  readonly cases: readonly { readonly name: string; readonly workspace?: "missing"; readonly steps: readonly Step[] }[];
}

const contract = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../../../sandboxes/internal/computer/testdata/contract.json", import.meta.url)), "utf8"),
) as Contract;

const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function ticket(kind: string | undefined, privateKey: KeyObject): string | undefined {
  const now = Math.floor(Date.now() / 1000);
  const header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT" };
  const claims: Record<string, unknown> = { aud: "nylorun-computer", sub: contract.name, exp: now + 600 };
  let key = privateKey;
  switch (kind ?? "valid") {
    case "valid":
      break;
    case "none":
      return undefined;
    case "garbage":
      return "a.b.c";
    case "expired":
      claims.exp = now - 1;
      break;
    case "noExp":
      delete claims.exp;
      break;
    case "otherSubject":
      claims.sub = "sbx-aaaaaaaaaaaaaaaa-g0";
      break;
    case "otherAudience":
      claims.aud = "nylorun-sandbox";
      break;
    case "otherKey":
      key = generateKeyPairSync("ed25519").privateKey;
      break;
    case "algHS256":
      header.alg = "HS256";
      break;
    default:
      throw new Error(`unknown ticket kind ${kind}`);
  }
  const input = `${encode(header)}.${encode(claims)}`;
  return `${input}.${sign(null, Buffer.from(input), key).toString("base64url")}`;
}

/** Compares an answer with the contract's expectation; undefined when it holds. */
function mismatch(got: unknown, want: unknown, fill: (text: string) => string, at = "$"): string | undefined {
  if (want !== null && typeof want === "object" && !Array.isArray(want)) {
    const keys = Object.keys(want);
    if (keys.length > 0 && keys.every((key) => key.startsWith("$"))) return matcher(got, want as Record<string, unknown>, fill, at);
    if (got === null || typeof got !== "object" || Array.isArray(got)) return `${at}: ${JSON.stringify(got)}, want an object`;
    for (const key of [...new Set([...Object.keys(got), ...keys])].sort()) {
      if (!(key in got) || !(key in want)) return `${at}.${key}: present in answer ${key in got}, in the contract ${key in want}`;
      const why = mismatch((got as Record<string, unknown>)[key], (want as Record<string, unknown>)[key], fill, `${at}.${key}`);
      if (why) return why;
    }
    return undefined;
  }
  if (Array.isArray(want)) {
    if (!Array.isArray(got) || got.length !== want.length) return `${at}: ${JSON.stringify(got)}, want ${want.length} items`;
    for (const [i, item] of want.entries()) {
      const why = mismatch(got[i], item, fill, `${at}[${i}]`);
      if (why) return why;
    }
    return undefined;
  }
  const expected = typeof want === "string" ? fill(want) : want;
  return got === expected ? undefined : `${at}: ${JSON.stringify(got)?.slice(0, 300)}, want ${JSON.stringify(expected)}`;
}

function matcher(got: unknown, m: Record<string, unknown>, fill: (text: string) => string, at: string): string | undefined {
  const text = typeof got === "string" ? got : undefined;
  for (const [key, value] of Object.entries(m)) {
    const fail = (why: string) => `${at}: ${JSON.stringify(got)?.slice(0, 300)} ${why}`;
    if (key === "$any") continue;
    if (key === "$type") {
      if (typeof got !== value) return fail(`is not a ${String(value)}`);
    } else if (key === "$startsWith") {
      if (text === undefined || !text.startsWith(fill(String(value)))) return fail(`doesn't start with ${JSON.stringify(value)}`);
    } else if (key === "$endsWith") {
      if (text === undefined || !text.endsWith(fill(String(value)))) return fail(`doesn't end with ${JSON.stringify(value)}`);
    } else if (key === "$matches") {
      if (text === undefined || !new RegExp(fill(String(value))).test(text)) return fail(`doesn't match ${JSON.stringify(value)}`);
    } else if (key === "$utf8Bytes") {
      if (text === undefined || Buffer.byteLength(text) !== value) return fail(`is ${Buffer.byteLength(text ?? "")} bytes, want ${String(value)}`);
    } else return `${at}: unknown matcher ${key}`;
  }
  return undefined;
}

describe("the computer's contract (the engine's --service computer)", () => {
  for (const kase of contract.cases)
    it(kase.name, { timeout: 60_000 }, async () => {
      const root = mkdtempSync(join(tmpdir(), "computer-contract-"));
      const workspace = join(root, "workspace");
      const harnessRoot = join(root, contract.harnessRoot);
      if (kase.workspace !== "missing") mkdirSync(workspace);
      const bundle = join(root, "trust.pem");
      const trust = Object.fromEntries(TRUST_VARIABLES.map((name) => [name, bundle]));
      const { publicKey, privateKey } = generateKeyPairSync("ed25519");
      const handle = await localBackend({
        env: baselineEnvironment(contract.processEnv),
        workspace,
        harnessRoot,
        proxyEnv: () => trust,
      }).open({ key: "computer", cpus: 1, memoryMiB: 512, network: { preset: "none", hosts: [], suffixes: [] } });
      // As runComputer's: the workspace is writable.
      const ready = () => {
        try {
          accessSync(workspace, constants.W_OK);
          return true;
        } catch {
          return false;
        }
      };
      const handler = computerHandler({ handle, key: publicKey, name: contract.name, ready });
      const server = createServer((request, response) => void handler(request, response));
      servers.push(server);
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const fill = (text: string) =>
        text.replaceAll("{{workspace}}", workspace).replaceAll("{{harnessRoot}}", harnessRoot).replaceAll("{{trustBundle}}", bundle);

      for (const [i, step] of kase.steps.entries()) {
        const label = `step ${i} (${step.request.method} ${step.request.path})`;
        const token = ticket(step.request.ticket, privateKey);
        const body =
          step.request.bodyText !== undefined
            ? fill(step.request.bodyText)
            : "body" in step.request
              ? fill(JSON.stringify(step.request.body))
              : undefined;
        const answer = await fetch(url + fill(step.request.path), {
          method: step.request.method,
          headers: token ? { "x-nylorun-ticket": token } : {},
          ...(body !== undefined ? { body } : {}),
        });
        const raw = Buffer.from(await answer.arrayBuffer()).toString("utf8");
        expect(answer.status, `${label}: ${raw.slice(0, 300)}`).toBe(step.expect.status);
        if (step.expect.contentType) expect(answer.headers.get("content-type"), label).toBe(step.expect.contentType);
        if (step.expect.text !== undefined) expect(raw, label).toBe(fill(step.expect.text));
        if (step.expect.json !== undefined) expect(mismatch(JSON.parse(raw), step.expect.json, fill), label).toBeUndefined();
      }
    });
});
