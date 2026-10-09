import { X509Certificate } from "node:crypto";
import { once } from "node:events";
import { connect, createServer, type AddressInfo } from "node:tls";
import { describe, expect, it } from "vitest";
import { createCertificateAuthority, issueLeafCertificate, leafKeyPair } from "../../src/keys/x509.js";

describe("egress CA and leaf certificates (R2c)", () => {
  const authority = createCertificateAuthority({ commonName: "Nylorun egress CA (test)" });

  it("builds a CA that Node parses as a CA", () => {
    const ca = new X509Certificate(authority.certificate);
    expect(ca.ca).toBe(true);
    expect(ca.subject).toContain("CN=Nylorun egress CA (test)");
    expect(ca.checkIssued(ca)).toBe(true);
    expect(authority.privateKey).toContain("BEGIN PRIVATE KEY");
  });

  it("issues a leaf for one host, signed by the CA", () => {
    const leaf = new X509Certificate(issueLeafCertificate({ authority, host: "api.github.com", publicKey: leafKeyPair().publicKey }));
    const ca = new X509Certificate(authority.certificate);
    expect(leaf.ca).toBe(false);
    expect(leaf.subjectAltName).toBe("DNS:api.github.com");
    expect(leaf.checkIssued(ca)).toBe(true);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost("api.github.com")).toBe("api.github.com");
    expect(leaf.checkHost("gist.github.com")).toBeUndefined();
  });

  it("is short-lived", () => {
    const now = new Date("2026-10-09T12:00:00Z");
    const leaf = new X509Certificate(issueLeafCertificate({ authority, host: "example.com", publicKey: leafKeyPair().publicKey, minutes: 10, now }));
    expect(Date.parse(leaf.validTo) - now.getTime()).toBe(10 * 60_000);
  });

  it("refuses a value that is not a host name", () => {
    const { publicKey } = leafKeyPair();
    expect(() => issueLeafCertificate({ authority, host: "1.2.3.4", publicKey })).toThrow(/Not a host name/);
    expect(() => issueLeafCertificate({ authority, host: "*.example.com", publicKey })).toThrow(/Not a host name/);
  });

  it("completes a TLS handshake that trusts only the CA", async () => {
    const keys = leafKeyPair();
    const certificate = issueLeafCertificate({ authority, host: "api.example.com", publicKey: keys.publicKey });
    const server = createServer({ key: keys.privateKey, cert: certificate }, (socket) => socket.end("ok"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const client = connect({ host: "127.0.0.1", port, servername: "api.example.com", ca: authority.certificate });
    const [chunk] = (await once(client, "data")) as [Buffer];
    expect(chunk.toString()).toBe("ok");
    expect(client.authorized).toBe(true);
    client.destroy();
    server.close();
  });
});
