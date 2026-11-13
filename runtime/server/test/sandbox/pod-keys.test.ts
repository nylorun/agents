/**
 * The keyed hosts core sends with a pod's spec (ADR-142, `sandbox/pods/keys.ts`): the vault's
 * secrets and slots (no value read) win, then the hosts the outside source lists for the owner,
 * inside the Tenant's ceiling; an embedder's provider without `keyedHosts` puts keys in
 * Authorization.
 */
import { describe, expect, it } from "vitest";
import { podKeysOf } from "../../src/sandbox/pods/keys.js";
import type { CredentialProvider } from "../../src/gates/credential-provider.js";

function store(rows: { type: string; name: string; bindingJson: string }[], slots?: Record<string, unknown>) {
  const t = {
    environment: async () => ({ applied: { secrets: slots } }),
    vaultOfEnvironment: async () => ({ id: "vault_1" }),
    credentialsForVault: async () => rows,
  };
  return { tx: async <T>(fn: (tx: never) => Promise<T>) => fn(t as never) } as never;
}

const secret = (name: string, hosts: string[], header?: string) => ({
  type: "environment_secret",
  name,
  bindingJson: JSON.stringify({ secretName: name, allowedHosts: hosts, ...(header ? { inject: { header, format: "Bearer {value}" } } : {}) }),
});

function provider(entries: { host: string; header: string }[], v1 = false): CredentialProvider {
  return {
    url: "http://source",
    environment: async () => [],
    hosts: async () => entries.map((e) => e.host),
    ...(v1 ? {} : { keyedHosts: async () => entries }),
    forwardUrl: (path) => new URL(path, "http://source"),
    forwardHeaders: () => ({}),
  };
}

describe("podKeysOf", () => {
  it("lists the vault's hosts with their headers, then the owner's, inside the ceiling", async () => {
    const keys = await podKeysOf(
      {
        store: store([secret("OPENAI_API_KEY", ["api.openai.com"]), secret("STRIPE", ["api.stripe.com"], "X-Stripe")]),
        credentialProvider: provider([
          { host: "api.github.com", header: "Authorization" },
          { host: "api.openai.com", header: "X-Wrong" },
          { host: "api.outside.test", header: "Authorization" },
        ]),
      },
      { sandboxId: "local/probe", owner: "u:acme:ana", ceiling: ["*.github.com", "api.openai.com"] },
    );
    expect(keys).toEqual({
      sandbox: "local/probe",
      hosts: [
        { host: "api.github.com", header: "Authorization" },
        { host: "api.openai.com", header: "Authorization" },
        { host: "api.stripe.com", header: "X-Stripe" },
      ],
    });
  });

  it("keeps a declared slot's hosts with no value in it, so its rule fails closed", async () => {
    const keys = await podKeysOf(
      {
        store: store([secret("UNDECLARED", ["api.undeclared.test"])], {
          GH_TOKEN: { type: "environment_secret", allowedHosts: ["uploads.github.com"], inject: { header: "X-Gh", format: "{value}" } },
        }),
      },
      { sandboxId: "a" },
    );
    expect(keys.hosts).toEqual([{ host: "uploads.github.com", header: "X-Gh" }]);
  });

  it("asks no source for an Agent with no owner, and reads a v1 provider as Authorization", async () => {
    const none = await podKeysOf(
      { store: store([]), credentialProvider: provider([{ host: "api.github.com", header: "X" }]) },
      { sandboxId: "a" },
    );
    expect(none.hosts).toEqual([]);
    const v1 = await podKeysOf(
      { store: store([]), credentialProvider: provider([{ host: "api.github.com", header: "X" }], true) },
      { sandboxId: "a", owner: "u:o:p" },
    );
    expect(v1.hosts).toEqual([{ host: "api.github.com", header: "Authorization" }]);
  });
});
