/**
 * The server name (SNI) in a TLS ClientHello, read from the first bytes a client sends through a
 * tunnel (ADR-92 §11). egress-gate compares it with the CONNECT host, so a tunnel opened to an
 * allowed host can't ask a shared front end for another one (domain fronting by SNI).
 *
 * The ClientHello may span several TLS records; they are reassembled up to `MAX_HELLO_BYTES`.
 */

/** A ClientHello is far smaller; one that isn't complete by here is refused. */
export const MAX_HELLO_BYTES = 64 * 1024;

const RECORD_HANDSHAKE = 0x16;
const HANDSHAKE_CLIENT_HELLO = 0x01;
const EXTENSION_SERVER_NAME = 0x0000;
const NAME_TYPE_HOST = 0x00;

export type ClientHelloRead =
  /** More bytes are needed. */
  | { readonly status: "incomplete" }
  /** Not a TLS ClientHello. */
  | { readonly status: "invalid"; readonly reason: string }
  /** A whole ClientHello; `serverName` is lowercase, or undefined when it names none. */
  | { readonly status: "complete"; readonly serverName?: string };

/** Reads the ClientHello at the start of `data`, the bytes a client has sent so far. */
export function readClientHello(data: Buffer): ClientHelloRead {
  // The handshake message, reassembled from consecutive handshake records.
  const chunks: Buffer[] = [];
  let have = 0;
  let need: number | undefined;
  let at = 0;
  while (need === undefined || have < need) {
    if (data.length < at + 5) return data.length > MAX_HELLO_BYTES ? invalid("too long") : incomplete;
    if (data[at] !== RECORD_HANDSHAKE) return invalid("not a TLS handshake");
    if (data[at + 1] !== 0x03) return invalid("not a TLS record");
    const length = data.readUInt16BE(at + 3);
    if (length === 0) return invalid("an empty record");
    if (data.length < at + 5 + length) return at + 5 + length > MAX_HELLO_BYTES ? invalid("too long") : incomplete;
    const fragment = data.subarray(at + 5, at + 5 + length);
    chunks.push(fragment);
    have += fragment.length;
    at += 5 + length;
    if (need === undefined && have >= 4) {
      const head = Buffer.concat(chunks);
      if (head[0] !== HANDSHAKE_CLIENT_HELLO) return invalid("not a ClientHello");
      need = 4 + head.readUIntBE(1, 3);
      if (need > MAX_HELLO_BYTES) return invalid("too long");
    }
  }
  return serverNameIn(Buffer.concat(chunks).subarray(4, need));
}

/** The server name in a ClientHello's body (after its 4-byte handshake header). */
function serverNameIn(body: Buffer): ClientHelloRead {
  let at = 2 + 32; // client_version, random
  if (body.length < at + 1) return invalid("truncated");
  at += 1 + body[at]!; // session_id
  if (body.length < at + 2) return invalid("truncated");
  at += 2 + body.readUInt16BE(at); // cipher_suites
  if (body.length < at + 1) return invalid("truncated");
  at += 1 + body[at]!; // compression_methods
  if (body.length === at) return { status: "complete" }; // no extensions
  if (body.length < at + 2) return invalid("truncated");
  const end = at + 2 + body.readUInt16BE(at);
  if (end > body.length) return invalid("truncated");
  at += 2;
  while (at + 4 <= end) {
    const type = body.readUInt16BE(at);
    const length = body.readUInt16BE(at + 2);
    const start = at + 4;
    if (start + length > end) return invalid("truncated");
    if (type === EXTENSION_SERVER_NAME) return hostIn(body.subarray(start, start + length));
    at = start + length;
  }
  return { status: "complete" };
}

/** The host name in a server_name extension's data. */
function hostIn(extension: Buffer): ClientHelloRead {
  if (extension.length < 2) return invalid("truncated");
  const end = Math.min(extension.length, 2 + extension.readUInt16BE(0));
  let at = 2;
  while (at + 3 <= end) {
    const type = extension[at]!;
    const length = extension.readUInt16BE(at + 1);
    if (at + 3 + length > end) return invalid("truncated");
    if (type === NAME_TYPE_HOST) {
      const name = extension.subarray(at + 3, at + 3 + length).toString("latin1");
      // A host name is letters, digits, hyphens and dots; anything else (a NUL, a space) is refused.
      if (!/^[A-Za-z0-9.-]+$/.test(name)) return invalid("a server name that isn't a host name");
      return { status: "complete", serverName: name.toLowerCase().replace(/\.$/, "") };
    }
    at += 3 + length;
  }
  return { status: "complete" };
}

const incomplete: ClientHelloRead = { status: "incomplete" };
const invalid = (reason: string): ClientHelloRead => ({ status: "invalid", reason });
