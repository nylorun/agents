/**
 * ADR-71: a model may use the Host's identity. A `host_identity` credential for `google-vertex`
 * keeps no secret, only the project and location. The Model Gate calls Agent Platform with Google's
 * Application Default Credentials, and only while the operator lends them
 * (`NYLORUN_MODEL_HOST_IDENTITY`). The Tenant's routes are in `host-identity-tenant.test.ts`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseStackConfig, StackConfigError } from "../src/host/stack-config.js";
import { piModel } from "../src/model/pi-model.js";
import type { RuntimeModelCall } from "../src/contracts.js";
import { hostIdentityEnv, hostIdentityRefused, useHostIdentity } from "../src/vault/host-identity.js";

const call: RuntimeModelCall = {
  sessionId: "test",
  tools: [],
  prompt: [{ kind: "message", role: "user", content: [{ type: "text", text: "hello" }] }],
};

const vertex = {
  readHostModel: () => ({
    provider: "google-vertex",
    model: "gemini-4-argon",
    authType: "host_identity" as const,
    credential: { type: "host_identity" as const, env: hostIdentityEnv("nylorun-bot-beta", "global") },
  }),
};

afterEach(() => {
  useHostIdentity([]);
  vi.unstubAllEnvs();
});

describe("lending the Host's identity", () => {
  it("is off until the operator lists the provider, and only google-vertex can have it", () => {
    expect(hostIdentityRefused("google-vertex")).toMatch(/NYLORUN_MODEL_HOST_IDENTITY=google-vertex/);
    useHostIdentity(["google-vertex"]);
    expect(hostIdentityRefused("google-vertex")).toBeUndefined();
    expect(hostIdentityRefused("anthropic")).toMatch(/google-vertex only, not anthropic/);
  });

  it("reads NYLORUN_MODEL_HOST_IDENTITY on the gates' process", () => {
    const gateway = { NYLORUN_GATES_TOKEN: "a".repeat(64), NYLORUN_GATES_ALLOWED_HOSTS: "gateway:4100" };
    const services = ["--service", "gates,keys"];
    expect(parseStackConfig(gateway, services).modelHostIdentity).toBeUndefined();
    expect(parseStackConfig({ ...gateway, NYLORUN_MODEL_HOST_IDENTITY: "" }, services).modelHostIdentity).toBeUndefined();
    expect(
      parseStackConfig({ ...gateway, NYLORUN_MODEL_HOST_IDENTITY: " google-vertex,google-vertex " }, services).modelHostIdentity,
    ).toEqual(["google-vertex"]);
    expect(() => parseStackConfig({ ...gateway, NYLORUN_MODEL_HOST_IDENTITY: "openai" }, services)).toThrow(StackConfigError);
  });
});

describe("a model on the Host's identity", () => {
  it("fails with auth, naming the setting, while the Host doesn't lend it", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(piModel({ root: "", ...vertex })(call, { signal: new AbortController().signal })).resolves.toMatchObject({
      kind: "failed",
      code: "auth",
      retryable: false,
      message: expect.stringContaining("NYLORUN_MODEL_HOST_IDENTITY"),
    });
    expect(fetch).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("calls Agent Platform in its project and location with Google's default credentials, no key", async () => {
    useHostIdentity(["google-vertex"]);
    // No metadata server and no credential file here: Google's library looks for them and says so.
    vi.stubEnv("METADATA_SERVER_DETECTION", "none");
    vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", "");
    const result = await piModel({ root: "", ...vertex })(call, { signal: new AbortController().signal });
    expect(result).toMatchObject({ kind: "failed" });
    const message = (result as { message: string }).message;
    expect(message).toMatch(/default credentials/i);
    // The project and location reached the client, so it went on to look for credentials.
    expect(message).not.toMatch(/requires a (project ID|location)/);
  });
});
