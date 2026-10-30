import { Duplex } from "node:stream";
import { connect as tlsConnect } from "node:tls";

/**
 * The ClientHello Node's TLS client sends for `serverName` (none when undefined), captured
 * without a network: a real client's first bytes, for tests of the gate's SNI check.
 */
export function clientHelloFor(serverName: string | undefined): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let captured = Buffer.alloc(0);
    const wire = new Duplex({
      read() {},
      write(chunk: Buffer, _encoding, done) {
        captured = Buffer.concat([captured, chunk]);
        done();
        // The hello is the first flight; nothing answers it here.
        setImmediate(() => {
          socket.destroy();
          resolve(captured);
        });
      },
    });
    const socket = tlsConnect({ socket: wire, ...(serverName ? { servername: serverName } : {}), rejectUnauthorized: false });
    socket.on("error", (error) => {
      if (captured.length === 0) reject(error);
    });
  });
}
