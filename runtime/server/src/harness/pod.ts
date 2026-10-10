/**
 * The engine in a pod sandbox (F7.2, D42): its credentials. It holds no harness token. Before
 * each connection to the Harness API it renews its host token (`host/renew`), or, with none or
 * one refused (its epoch moved), exchanges the join token mounted in the pod (`host/join`,
 * read afresh each time: a reset writes a new one). The egress token minted with the host token
 * is the password of the proxy every command gets (`proxyEnv`); both are renewed every
 * `RENEW_MS`, well inside their 15-minute life.
 *
 * The join answer also carries the installation's egress CA (R2c, D50). The engine writes it,
 * after the public roots, to a trust bundle on the pod (`caBundleFile`) and points every
 * command's trust variables at it, so a CLI trusts the leaf egress-gate presents for a host an
 * `environment_secret` is bound to. The bundle is rewritten only when the CA changes.
 */
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { dirname } from "node:path";
import type { PodHostConfig } from "../host/stack-config.js";

/** How often the host and egress tokens are renewed. */
export const RENEW_MS = 5 * 60_000;

interface Held {
  readonly hostToken: string;
  readonly egressToken: string;
  readonly epoch: number;
  readonly expiresAt: number;
  readonly caCertificate?: string;
}

/** The variables CLIs read their trust bundle from: OpenSSL, Node, Python, curl, git, AWS. */
const TRUST_VARIABLES = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
  "AWS_CA_BUNDLE",
] as const;

export interface PodHost {
  /** A current host token, for the next connection. Throws when neither renewal nor join works. */
  token(): Promise<string>;
  /** `HTTPS_PROXY` and friends with the current egress token; none before the first join. */
  proxyEnv(): Record<string, string>;
  /** The host epoch of the tokens held. */
  readonly epoch: number | undefined;
  stop(): void;
}

class Refused extends Error {}

export function podHost(
  config: PodHostConfig,
  logger: { info(message: string, fields?: Record<string, unknown>): void; warn(message: string, fields?: Record<string, unknown>): void },
  options: {
    fetch?: typeof fetch;
    renewMs?: number;
    /** Where the engine keeps the volume's id (on the volume): a new volume gets a new one. */
    volumeFile?: string;
    /** Where the engine writes the trust bundle: the public roots and the egress CA (R2c). */
    caBundleFile?: string;
  } = {},
): PodHost {
  const call = options.fetch ?? fetch;
  let held: Held | undefined;
  /** The CA in the bundle on disk, once one is written. */
  let bundled: string | undefined;

  const post = async (path: string, init: { body?: unknown; bearer?: string }): Promise<Held> => {
    const response = await call(`${config.httpUrl}/nylorun/harness/v1/host/${path}`, {
      method: "POST",
      headers: {
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status === 401 || response.status === 400) throw new Refused(`host/${path} refused: ${response.status}`);
    if (!response.ok) throw new Error(`host/${path} answered ${response.status}`);
    const body = JSON.parse(text) as {
      hostToken: string;
      egressToken: string;
      epoch: number;
      expiresAt: string;
      caCertificate?: string;
    };
    if (typeof body.caCertificate === "string") await writeBundle(body.caCertificate);
    return {
      hostToken: body.hostToken,
      egressToken: body.egressToken,
      epoch: body.epoch,
      expiresAt: Date.parse(body.expiresAt),
      ...(typeof body.caCertificate === "string" ? { caCertificate: body.caCertificate } : {}),
    };
  };

  const writeBundle = async (ca: string): Promise<void> => {
    const file = options.caBundleFile;
    if (!file || ca === bundled) return;
    await mkdir(dirname(file), { recursive: true });
    // Written beside it and renamed, so a command never reads half a bundle.
    const next = `${file}.${randomUUID()}`;
    await writeFile(next, `${rootCertificates.join("\n")}\n${ca.trim()}\n`, { mode: 0o644 });
    await rename(next, file);
    bundled = ca;
  };

  /** The volume's id, created on a volume that has none. */
  const volumeId = async (): Promise<string | undefined> => {
    const file = options.volumeFile;
    if (!file) return undefined;
    try {
      return (await readFile(file, "utf8")).trim();
    } catch {
      const id = randomUUID();
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `${id}\n`, { mode: 0o600 });
      return id;
    }
  };

  const join = async (): Promise<Held> => {
    const joinToken = (await readFile(config.joinFile, "utf8")).trim();
    const volume = await volumeId();
    held = await post("join", {
      body: {
        sandboxId: config.sandboxId,
        podUid: config.podUid,
        joinToken,
        ...(volume === undefined ? {} : { volumeId: volume }),
      },
    });
    logger.info("sandbox_host_joined", { sandboxId: config.sandboxId, epoch: held.epoch });
    return held;
  };

  const renew = async (): Promise<Held | undefined> => {
    if (!held) return undefined;
    try {
      held = await post("renew", { bearer: held.hostToken });
      return held;
    } catch (error) {
      if (error instanceof Refused) {
        logger.warn("sandbox_host_renew_refused", { sandboxId: config.sandboxId, epoch: held.epoch });
        held = undefined;
        return undefined;
      }
      throw error;
    }
  };

  const timer = setInterval(() => {
    void renew().catch((error: unknown) =>
      logger.warn("sandbox_host_renew_failed", { message: error instanceof Error ? error.message : String(error) }),
    );
  }, options.renewMs ?? RENEW_MS);
  timer.unref();

  return {
    async token() {
      const current = (await renew()) ?? (await join());
      return current.hostToken;
    },
    proxyEnv(): Record<string, string> {
      if (!config.egressProxy || !held) return {};
      const url = new URL(config.egressProxy);
      url.username = "nylorun";
      url.password = held.egressToken;
      const proxy = url.toString().replace(/\/$/, "");
      const trust =
        bundled !== undefined && options.caBundleFile
          ? Object.fromEntries(TRUST_VARIABLES.map((name) => [name, options.caBundleFile!]))
          : {};
      return {
        ...trust,
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
      };
    },
    get epoch() {
      return held?.epoch;
    },
    stop() {
      clearInterval(timer);
    },
  };
}
