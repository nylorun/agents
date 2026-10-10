/**
 * The installation's egress CA (R2c, D50, E12): one long-lived certificate authority whose
 * certificate every pod sandbox trusts, and whose key signs the short-lived leaf egress-gate
 * presents when it terminates TLS for a host an `environment_secret` is bound to. Only keys holds
 * the key: it lives in the Tenant setting `egress.ca`, sealed under the vault KEK like a signing
 * key, beside the certificate in the clear. Created on first use under the signing keys' lock.
 * No rotation yet (R8, with the KeyRoot seam).
 */
import { X509Certificate } from "node:crypto";
import type { SessionStore, Tx } from "../store/types.js";
import { decryptSecret, encryptSecret } from "../vault/crypto.js";
import { createCertificateAuthority, issueLeafCertificate, type CertificateAuthority } from "./x509.js";

const SETTING = "egress.ca";
/** How long a leaf egress-gate presents is valid: one connection rarely lasts this long. */
export const EGRESS_LEAF_MINUTES = 60;

interface StoredAuthority {
  readonly certificate: string;
  readonly kekId: string;
  readonly nonce: string;
  readonly ciphertext: string;
  readonly wrappedDek: string;
}

function aad(certificate: string): Buffer {
  return Buffer.from(`nylorun.egress-ca:${new X509Certificate(certificate).fingerprint256}`);
}

export class EgressAuthority {
  /** The CA with its key, decrypted once per process, as signing keys are. */
  private authority: CertificateAuthority | undefined;

  constructor(
    private readonly store: SessionStore,
    private readonly kek: () => Buffer,
  ) {}

  /** The CA certificate (PEM), creating the CA when the Tenant has none. */
  async certificate(): Promise<string> {
    return (await this.load()).certificate;
  }

  /** A leaf for `host` and the caller's P-256 public key (SPKI PEM); the caller keeps its key. */
  async signLeaf(host: string, publicKey: string): Promise<string> {
    return issueLeafCertificate({ authority: await this.load(), host, publicKey, minutes: EGRESS_LEAF_MINUTES });
  }

  private async load(): Promise<CertificateAuthority> {
    if (this.authority) return this.authority;
    const kek = this.kek();
    const stored = await this.store.tx(async (t) => (await read(t)) ?? (await create(t, kek)));
    const privateKey = decryptSecret(
      kek,
      aad(stored.certificate),
      Buffer.from(stored.nonce, "base64"),
      Buffer.from(stored.ciphertext, "base64"),
      Buffer.from(stored.wrappedDek, "base64"),
      stored.kekId,
    ).toString("utf8");
    this.authority = { certificate: stored.certificate, privateKey };
    return this.authority;
  }
}

async function read(t: Tx): Promise<StoredAuthority | undefined> {
  const value = await t.getSetting(SETTING);
  return value === undefined ? undefined : (JSON.parse(value) as StoredAuthority);
}

async function create(t: Tx, kek: Buffer): Promise<StoredAuthority> {
  // Concurrent first uses would both create a CA: lock, then read what the winner made.
  await t.lockSigningKeys();
  const existing = await read(t);
  if (existing) return existing;
  const authority = createCertificateAuthority({ commonName: "Nylorun egress CA" });
  const sealed = encryptSecret(kek, aad(authority.certificate), Buffer.from(authority.privateKey, "utf8"));
  const stored: StoredAuthority = {
    certificate: authority.certificate,
    kekId: sealed.kekId,
    nonce: sealed.nonce.toString("base64"),
    ciphertext: sealed.ciphertext.toString("base64"),
    wrappedDek: sealed.wrappedDek.toString("base64"),
  };
  await t.putSetting(SETTING, JSON.stringify(stored));
  return stored;
}
