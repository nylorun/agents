/**
 * The harness as a sandbox pod's entrypoint. A pod holds no harness token: it exchanges the
 * join token mounted in the pod for a host token (`host/join`), renews it every 5 minutes
 * (`host/renew`), and connects with the host token as its bearer; that connection serves its
 * sandbox's runs alone. The egress token that comes with it is the password of the egress proxy
 * every command must use, and the egress CA joins the public roots in a trust bundle those
 * commands read.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { rootCertificates } from "node:tls";
import { join } from "node:path";
import {
  HOST_JOIN_PATH,
  HOST_RENEW_PATH,
  HostJoinAnswerSchema,
  type HostJoinAnswer,
  type HostJoinRequest,
} from "@nylorun/core/harness-api";

export interface PodConfig {
  /** `NYLORUN_SANDBOX_ID`. */
  readonly sandboxId: string;
  /** `NYLORUN_POD_UID`. */
  readonly podUid: string;
  /** `NYLORUN_SANDBOX_JOIN_FILE`: read afresh for each join, as a reset writes a new token. */
  readonly joinFile: string;
  /** `NYLORUN_HARNESS_URL`: the Harness API listener, `http://<host>:<port>`. */
  readonly harnessUrl: string;
  /** `NYLORUN_EGRESS_PROXY`. */
  readonly egressProxy?: string;
  /** The pod's volume for harness state, `/harness`: the volume id and the trust bundle. */
  readonly root: string;
}

/** The variables CLIs read a trust bundle from. */
const TRUST = [
  "SSL_CERT_FILE",
  "NODE_EXTRA_CA_CERTS",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "GIT_SSL_CAINFO",
];

export function podHost(config: PodConfig) {
  const bundle = join(config.root, "egress-ca-bundle.pem");
  let held: HostJoinAnswer | undefined;
  let bundled: string | undefined;

  const post = async (path: string, init: { body?: HostJoinRequest; bearer?: string }) => {
    const url = new URL(path, config.harnessUrl.replace(/^ws/, "http"));
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`${path} answered ${response.status}`);
    const answer = HostJoinAnswerSchema.parse(await response.json());
    if (answer.caCertificate !== bundled) {
      // Written beside it and renamed, so a command never reads half a bundle.
      const next = `${bundle}.${randomUUID()}`;
      writeFileSync(next, `${rootCertificates.join("\n")}\n${answer.caCertificate.trim()}\n`, {
        mode: 0o644,
      });
      renameSync(next, bundle);
      bundled = answer.caCertificate;
    }
    return (held = answer);
  };

  /** The volume's id: a volume recreated empty gets a new one, which core tells apart. */
  const volumeId = () => {
    const file = join(config.root, "volume-id");
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      const id = randomUUID();
      mkdirSync(config.root, { recursive: true });
      writeFileSync(file, `${id}\n`, { mode: 0o600 });
      return id;
    }
  };

  const joinPod = () =>
    post(HOST_JOIN_PATH, {
      body: {
        sandboxId: config.sandboxId,
        podUid: config.podUid,
        joinToken: readFileSync(config.joinFile, "utf8").trim(),
        volumeId: volumeId(),
      },
    });

  /** Renews the host token; a refusal (the sandbox's epoch moved) means joining again. */
  const renew = async () => {
    if (!held) return joinPod();
    try {
      return await post(HOST_RENEW_PATH, { bearer: held.hostToken });
    } catch {
      return joinPod();
    }
  };

  const timer = setInterval(() => void renew().catch(() => undefined), 5 * 60_000);

  return {
    /** A current host token, for the next connection. */
    async token(): Promise<string> {
      return (await renew()).hostToken;
    },
    /** The proxy and trust variables every command gets. */
    commandEnv(): Record<string, string> {
      if (!config.egressProxy || !held) return {};
      const url = new URL(config.egressProxy);
      url.username = "nylorun";
      url.password = held.egressToken;
      const proxy = url.toString().replace(/\/$/, "");
      return {
        ...Object.fromEntries(TRUST.map((name) => [name, bundle])),
        HTTPS_PROXY: proxy,
        HTTP_PROXY: proxy,
        https_proxy: proxy,
        http_proxy: proxy,
        NO_PROXY: "localhost,127.0.0.1",
        no_proxy: "localhost,127.0.0.1",
      };
    },
    stop() {
      clearInterval(timer);
    },
  };
}
