import { describe, expect, it } from "vitest";
import { MAX_HELLO_BYTES, readClientHello } from "../../src/gates/client-hello.js";
import { clientHelloFor } from "../support/tls-hello.js";

describe("readClientHello (ADR-92 §11)", () => {
  it("reads the server name a TLS client sends, lowercase", async () => {
    expect(readClientHello(await clientHelloFor("Registry.NPMJS.org"))).toEqual({ status: "complete", serverName: "registry.npmjs.org" });
    expect(readClientHello(await clientHelloFor(undefined))).toEqual({ status: "complete" });
  });

  it("asks for more until the whole hello is there", async () => {
    const hello = await clientHelloFor("pypi.org");
    for (const cut of [0, 3, 5, 40, hello.length - 1]) expect(readClientHello(hello.subarray(0, cut))).toEqual({ status: "incomplete" });
  });

  it("reassembles a hello split over two TLS records", async () => {
    const hello = await clientHelloFor("github.com");
    const body = hello.subarray(5, 5 + hello.readUInt16BE(3));
    const record = (fragment: Buffer) => Buffer.concat([Buffer.from([0x16, 0x03, 0x01, fragment.length >> 8, fragment.length & 0xff]), fragment]);
    const split = Buffer.concat([record(body.subarray(0, 10)), record(body.subarray(10))]);
    expect(readClientHello(split)).toEqual({ status: "complete", serverName: "github.com" });
  });

  it("refuses bytes that aren't a ClientHello, and a name that isn't a host name", async () => {
    expect(readClientHello(Buffer.from("GET / HTTP/1.1\r\n\r\n")).status).toBe("invalid");
    expect(readClientHello(Buffer.from([0x17, 0x03, 0x03, 0x00, 0x01, 0x00])).status).toBe("invalid");
    const hello = await clientHelloFor("aaaa.test");
    const at = hello.indexOf(Buffer.from("aaaa.test"));
    const tampered = Buffer.from(hello);
    tampered[at + 2] = 0x00; // "aa\0a.test"
    expect(readClientHello(tampered)).toEqual({ status: "invalid", reason: "a server name that isn't a host name" });
  });

  it("gives up on a hello longer than it allows", () => {
    const huge = Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0xff, 0xff]), Buffer.alloc(0xffff)]);
    const many = Buffer.concat(Array.from({ length: 2 }, () => huge));
    expect(many.length).toBeGreaterThan(MAX_HELLO_BYTES);
    expect(readClientHello(many).status).toBe("invalid");
  });
});
