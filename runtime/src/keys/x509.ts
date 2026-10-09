/**
 * The two certificates R2c needs (D50), built without a dependency: the installation's egress
 * CA, and a short-lived leaf for one host name that egress-gate presents when it terminates TLS
 * for a host an `environment_secret` is bound to. Node can parse X.509 but not build it, so this
 * writes the DER by hand. Both use ECDSA P-256 with SHA-256.
 *
 * Only what clients check is written: a CA with basicConstraints CA:TRUE (critical), keyUsage
 * keyCertSign and cRLSign (critical) and a subject key identifier; a leaf with the host as its
 * only subjectAltName, keyUsage digitalSignature (critical), extKeyUsage serverAuth, and the
 * CA's key identifier. Go (`gh`), OpenSSL (`curl`, `git`), Node and Python accept that shape.
 */
import { isIP } from "node:net";
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  X509Certificate,
  type KeyObject,
} from "node:crypto";

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
  subjectAltName: "2.5.29.17",
  subjectKeyIdentifier: "2.5.29.14",
  authorityKeyIdentifier: "2.5.29.35",
} as const;

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) bytes.unshift(v & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), length(content.length), content]);
}

const seq = (...items: Buffer[]) => tlv(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => tlv(0x31, Buffer.concat(items));
const octets = (content: Buffer) => tlv(0x04, content);
const bits = (content: Buffer, unused = 0) => tlv(0x03, Buffer.concat([Buffer.from([unused]), content]));
const bool = (value: boolean) => tlv(0x01, Buffer.from([value ? 0xff : 0x00]));
const explicit = (n: number, content: Buffer) => tlv(0xa0 + n, content);

function integer(value: Buffer): Buffer {
  let v = value;
  while (v.length > 1 && v[0] === 0 && (v[1]! & 0x80) === 0) v = v.subarray(1);
  if (v[0]! & 0x80) v = Buffer.concat([Buffer.from([0]), v]);
  return tlv(0x02, v);
}

function oid(dotted: string): Buffer {
  const parts = dotted.split(".").map(Number);
  const out: number[] = [40 * parts[0]! + parts[1]!];
  for (const part of parts.slice(2)) {
    const chunk: number[] = [part & 0x7f];
    for (let v = Math.floor(part / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    out.push(...chunk);
  }
  return tlv(0x06, Buffer.from(out));
}

function name(fields: { commonName: string; organization?: string }): Buffer {
  const rdns = [set(seq(oid(OID.commonName), tlv(0x0c, Buffer.from(fields.commonName, "utf8"))))];
  if (fields.organization)
    rdns.unshift(set(seq(oid(OID.organization), tlv(0x0c, Buffer.from(fields.organization, "utf8")))));
  return seq(...rdns);
}

/** UTCTime before 2050, GeneralizedTime from then on (RFC 5280 §4.1.2.5). */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14) + "Z";
  return at.getUTCFullYear() < 2050 ? tlv(0x17, Buffer.from(iso.slice(2), "ascii")) : tlv(0x18, Buffer.from(iso, "ascii"));
}

function extension(id: string, critical: boolean, value: Buffer): Buffer {
  return critical ? seq(oid(id), bool(true), octets(value)) : seq(oid(id), octets(value));
}

function spki(key: KeyObject): Buffer {
  return key.export({ type: "spki", format: "der" });
}

/** SHA-1 of the subjectPublicKey bits (RFC 5280 §4.2.1.2, method 1). */
function keyIdentifier(publicKey: KeyObject): Buffer {
  const der = spki(publicKey);
  // The SPKI is SEQUENCE { AlgorithmIdentifier, BIT STRING }; for P-256 the key is its last 65 bytes.
  return createHash("sha1").update(der.subarray(der.length - 65)).digest();
}

function serial(): Buffer {
  const value = randomBytes(16);
  value[0] = value[0]! & 0x7f;
  return integer(value);
}

function certificate(tbs: Buffer, issuerKey: KeyObject): Buffer {
  const algorithm = seq(oid(OID.ecdsaWithSha256));
  const signature = sign("sha256", tbs, issuerKey);
  return seq(tbs, algorithm, bits(signature));
}

function pem(der: Buffer): string {
  const body = der.toString("base64").replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export interface CertificateAuthority {
  /** PEM of the CA certificate: the only part a sandbox ever receives. */
  readonly certificate: string;
  /** PKCS#8 PEM of the CA key: sealed in the vault, used only by keys. */
  readonly privateKey: string;
}


/** A new P-256 CA, valid from an hour ago for `days` days. */
export function createCertificateAuthority(options: {
  readonly commonName: string;
  readonly days?: number;
  readonly now?: Date;
}): CertificateAuthority {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const now = options.now ?? new Date();
  const subject = name({ commonName: options.commonName, organization: "Nylorun" });
  const ski = keyIdentifier(publicKey);
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    serial(),
    seq(oid(OID.ecdsaWithSha256)),
    subject,
    seq(time(new Date(now.getTime() - 3_600_000)), time(new Date(now.getTime() + (options.days ?? 3650) * 86_400_000))),
    subject,
    spki(publicKey),
    explicit(
      3,
      seq(
        extension(OID.basicConstraints, true, seq(bool(true), integer(Buffer.from([0])))),
        extension(OID.keyUsage, true, bits(Buffer.from([0x06]), 1)),
        extension(OID.subjectKeyIdentifier, false, octets(ski)),
      ),
    ),
  );
  return {
    certificate: pem(certificate(tbs, privateKey)),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/**
 * A leaf for `host` and the caller's `publicKey` (SPKI PEM), signed by the CA, valid from five
 * minutes ago for `minutes` minutes. The caller keeps the leaf's private key: only the
 * certificate comes back, so no private key leaves whoever holds it.
 */
export function issueLeafCertificate(options: {
  readonly authority: CertificateAuthority;
  readonly host: string;
  readonly publicKey: string;
  readonly minutes?: number;
  readonly now?: Date;
}): string {
  if (isIP(options.host) !== 0 || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(options.host))
    throw new Error(`Not a host name: ${options.host}`);
  const caKey = createPrivateKey(options.authority.privateKey);
  const ca = new X509Certificate(options.authority.certificate);
  const publicKey = createPublicKey(options.publicKey);
  if (publicKey.asymmetricKeyType !== "ec" || publicKey.asymmetricKeyDetails?.namedCurve !== "prime256v1")
    throw new Error("A leaf key must be ECDSA P-256");
  const now = options.now ?? new Date();
  const issuer = Buffer.from(ca.raw);
  const tbs = seq(
    explicit(0, integer(Buffer.from([2]))),
    serial(),
    seq(oid(OID.ecdsaWithSha256)),
    subjectOf(issuer),
    seq(time(new Date(now.getTime() - 300_000)), time(new Date(now.getTime() + (options.minutes ?? 60) * 60_000))),
    name({ commonName: options.host }),
    spki(publicKey),
    explicit(
      3,
      seq(
        extension(OID.keyUsage, true, bits(Buffer.from([0x80]), 7)),
        extension(OID.extKeyUsage, false, seq(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, seq(tlv(0x82, Buffer.from(options.host, "ascii")))),
        extension(OID.authorityKeyIdentifier, false, seq(tlv(0x80, keyIdentifier(ca.publicKey)))),
      ),
    ),
  );
  return pem(certificate(tbs, caKey));
}

/** A P-256 key pair for a leaf, as PEM: SPKI for the public key, PKCS#8 for the private key. */
export function leafKeyPair(): { readonly publicKey: string; readonly privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** The subject Name of a DER certificate, byte for byte, to use as a leaf's issuer. */
function subjectOf(der: Buffer): Buffer {
  // Certificate ::= SEQUENCE { tbs SEQUENCE { [0] version, serial, sigAlg, issuer, validity, subject, … } }
  const read = (buf: Buffer, at: number) => {
    let len = buf[at + 1]!;
    let header = 2;
    if (len & 0x80) {
      const n = len & 0x7f;
      len = 0;
      for (let i = 0; i < n; i++) len = len * 256 + buf[at + 2 + i]!;
      header += n;
    }
    return { start: at, header, end: at + header + len };
  };
  const cert = read(der, 0);
  const tbs = read(der, cert.start + cert.header);
  // TBSCertificate fields: [0] version, serial, signature, issuer, validity, subject.
  let at = tbs.start + tbs.header;
  for (let field = 0; field < 5; field++) at = read(der, at).end;
  const subject = read(der, at);
  return der.subarray(subject.start, subject.end);
}
