import { createServer } from "node:net";

export const DEFAULT_PORTS = {
  runtime: 8787,
  studio: 4161,
  restate: 9070,
  openshell: 18080,
  openshellHealth: 18081,
} as const;

/** How the stack finds ports on 127.0.0.1; injectable for tests. */
export interface PortProbe {
  isFree(port: number): Promise<boolean>;
  /** A port the OS reports free right now. */
  pickFree(): Promise<number>;
}

function listenOnce(port: number): Promise<number | undefined> {
  const server = createServer();
  return new Promise((resolve) => {
    server.once("error", () => resolve(undefined));
    server.listen({ port, host: "127.0.0.1", exclusive: true }, () => {
      const address = server.address();
      const bound = typeof address === "object" && address ? address.port : undefined;
      server.close(() => resolve(bound));
    });
  });
}

export const loopbackPorts: PortProbe = {
  async isFree(port) {
    return (await listenOnce(port)) !== undefined;
  },
  async pickFree() {
    const port = await listenOnce(0);
    if (port === undefined) throw new Error("Could not allocate a free loopback port.");
    return port;
  },
};

/**
 * Choose a port: the persisted one if any (kept even when busy, because the
 * running stack may hold it), else the default when free, else a free one.
 * Never returns a port in `taken`.
 */
export async function choosePort(
  probe: PortProbe,
  preferred: number,
  persisted: number | undefined,
  taken: ReadonlySet<number>,
): Promise<number> {
  if (persisted !== undefined && !taken.has(persisted)) return persisted;
  if (!taken.has(preferred) && (await probe.isFree(preferred))) return preferred;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const port = await probe.pickFree();
    if (!taken.has(port)) return port;
  }
  throw new Error("Could not allocate a free loopback port.");
}
