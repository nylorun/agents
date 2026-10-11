/**
 * How a harness reaches core (R4.5). Three version numbers apply, and each moves on its own:
 *
 * - the transport: path `/nylorun/harness/v1` and header `Nylorun-Harness-Api: 1`, for the
 *   WebSocket and its frames (`FrameSchema`), one JSON text message per frame;
 * - the messages: `HARNESS_API_VERSION` (2), which a harness names in `hello.api` and core
 *   checks;
 * - the Runtime's protocol, which the Runtime and Management APIs carry, never this one.
 *
 * A harness container connects with `Authorization: Bearer <harness token>`. The harness in a
 * pod sandbox holds no harness token: it exchanges the join token mounted in its pod for a host
 * token (`POST .../host/join`), renews it (`POST .../host/renew`, `Authorization: Bearer <host
 * token>`) every few minutes, and connects with the host token as its bearer. That connection
 * serves its sandbox alone. Every refused join or renewal is the same `401`.
 */
import { z } from "zod";

/** The URL path of the Harness API's WebSocket, on core's harness port (4200 by default). */
export const HARNESS_API_PATH = "/nylorun/harness/v1";

/** The upgrade header naming the transport version, and the only value accepted. */
export const HARNESS_API_HEADER = "nylorun-harness-api";
export const HARNESS_API_TRANSPORT = "1";

/** Largest frame either end accepts. */
export const HARNESS_MAX_PAYLOAD = 64 * 1024 * 1024;

/** Where a pod's harness exchanges its join token, and renews its host token. */
export const HOST_JOIN_PATH = `${HARNESS_API_PATH}/host/join`;
export const HOST_RENEW_PATH = `${HARNESS_API_PATH}/host/renew`;

/**
 * A pod's join: its sandbox (`NYLORUN_SANDBOX_ID`), its pod's UID, the join token read from the
 * mounted join file (afresh each time: a reset writes a new one), and the id the harness keeps on
 * the volume (`/harness/volume-id`), so a volume recreated empty is told apart.
 */
export const HostJoinRequestSchema = z.strictObject({
  sandboxId: z.string().min(1),
  podUid: z.string().regex(/^[A-Za-z0-9-]{1,64}$/),
  joinToken: z.string().min(1).max(512),
  volumeId: z
    .string()
    .regex(/^[A-Za-z0-9-]{1,64}$/)
    .optional(),
});
export type HostJoinRequest = z.infer<typeof HostJoinRequestSchema>;

/**
 * What `host/join` and `host/renew` answer. The host token is the WebSocket bearer; the egress
 * token is the password of the egress proxy every command the harness runs must use
 * (`NYLORUN_EGRESS_PROXY`); `caCertificate` is the egress CA (PEM), which the harness adds to the
 * trust bundle of those commands. Both tokens expire at `expiresAt`.
 */
export const HostJoinAnswerSchema = z.strictObject({
  hostToken: z.string(),
  egressToken: z.string(),
  sandboxId: z.string(),
  epoch: z.number().int(),
  expiresAt: z.string(),
  caCertificate: z.string(),
});
export type HostJoinAnswer = z.infer<typeof HostJoinAnswerSchema>;
