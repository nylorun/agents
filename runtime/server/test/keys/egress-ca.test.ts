/**
 * The egress CA in keys (R2c, D50): created once per Tenant under a lock, its key sealed with the
 * vault key in the Tenant's settings, the same CA for every process; leaves for the caller's key.
 */
import { X509Certificate } from "node:crypto";
import { describe, expect, it } from "vitest";
import { EgressAuthority } from "../../src/keys/egress-ca.js";
import { leafKeyPair } from "../../src/keys/x509.js";
import { createTestSessionStore } from "../support/store.js";

const KEK = Buffer.alloc(32, 3);

describe("the egress CA (R2c)", () => {
  it("is created once, concurrently too, and shared by every process of the Tenant", async () => {
    const store = await createTestSessionStore();
    const first = new EgressAuthority(store, () => KEK);
    const second = new EgressAuthority(store, () => KEK);
    const [a, b] = await Promise.all([first.certificate(), second.certificate()]);
    expect(a).toBe(b);
    expect(new X509Certificate(a).ca).toBe(true);
    const stored = await store.tx((t) => t.getSetting("egress.ca"));
    expect(stored).toContain("BEGIN CERTIFICATE");
    expect(stored).not.toContain("PRIVATE KEY");
    const pair = leafKeyPair();
    const leaf = new X509Certificate(await new EgressAuthority(store, () => KEK).signLeaf("api.github.com", pair.publicKey));
    expect(leaf.checkIssued(new X509Certificate(a))).toBe(true);
    expect(leaf.subjectAltName).toBe("DNS:api.github.com");
  });

  it("cannot be used with another vault key", async () => {
    const store = await createTestSessionStore();
    await new EgressAuthority(store, () => KEK).certificate();
    await expect(new EgressAuthority(store, () => Buffer.alloc(32, 4)).certificate()).rejects.toThrow();
  });
});
