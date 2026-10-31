export { hashManifest } from "./utils/hash.js";

/**
 * Protocol 18: session usage by token kind. A model call read (`/v1/sessions/{id}/calls/model`,
 * `/v1/tenant/calls/model`) carries the gate's timing (`startedAt`, `endedAt`) and its cost by
 * token kind (`usage.costSplit`), and a session's usage (`/v1/sessions/{id}/usage`) adds
 * `costSplit`, `splitCalls`, `modelTimeMs` and `timedCalls`. The Host serves protocol 16, 17 and 18:
 * an older client, whose SDK parses these reads strictly, gets them without the new fields.
 * Protocol 17: a queue per session. A message sent while the session's turn runs,
 * or while it waits on an approval, an answer or an uncertain call, is queued
 * (`{status: "queued", queuedMessageId, position}`, `message.queued`) instead of refused, unless
 * it asks `delivery: "reject"`; the refusal now has a code, `409 session_busy`. When the turn ends
 * (completed, failed or cancelled), every queued message starts one turn, in order, each its own
 * user message (`queue.taken`); our engine's turn input for more than one is
 * `{kind: "messages", messages}` (Harness API 5, additive). Past the Runtime limit
 * `sessionQueuedMessages` a message is `429 queue_full`. Session reads count `queuedMessages`. The
 * Host serves protocol 16 and 17: a message from a protocol 16 client is `reject` unless it says
 * otherwise, so its sessions answer `409` as before.
 * Protocol 16: Agents from one manifest, a fresh start. An agent manifest (v8) is one
 * versioned document at `/v1/agent-manifests/{name}` with a `harness` section (what runs inside
 * the loop, including the harness's id) and a `runtime` section (what an environment manifest
 * said); the Runtime checks the two against each other when it is saved
 * (`422 manifest_inconsistent`), so `requires` and `409 environment_unsuitable` are gone, and so
 * are agent definitions (`PUT /v1/agents/:id` with a v7 manifest) and environment manifests.
 * Environments are Agents: `/v1/agents/{id}` (with `.../events`, `stop`, `reset`, `snapshot`,
 * `restore`, `versions`, `fork` and `secrets`) is made from a saved manifest only, records it as
 * tracking (`name`) or pinned (`name@n`) into `resolvedVersion`, the version it runs. An Agent
 * evolves: a `PUT` naming another version of its manifest moves it (`dryRun`
 * answers the plan), a save moves every Agent that tracks the manifest, and each turn takes the
 * version its Agent runs when it starts; a runtime change waits for a pod's next start, and its
 * kind, harness and storage are fixed (`409 agent_fixed_field`). Reads add `state`
 * (`working`, `sleeping`, `input_required`, `failing`, `paused`) and `attention`, and the
 * compute's state moves to `compute.state`. Every session belongs to one Agent:
 * `PUT /v1/sessions/{id}` takes `{ agent, ownerUserId, info }` and pins the manifest version its
 * Agent runs; no session is special. Error codes, event types (`agent.*`), the scopes
 * (`agents:write`, `agent-manifests:write`) and identity-file grants (`agents`) say Agent. Model
 * budget scope `agent` is `manifest`. Harness API 5: `turn.start.agent` replaces
 * `turn.start.environment`. Sessions opened before protocol 16 are closed (`protocol_16`) and
 * stay readable; Environments, their disks and vaults are gone. The Host serves protocol 16 only.
 * Protocol 15: the harness boundary, a fresh start. Model-facing work belongs to the harness. Our
 * engine's `read_artifact` and `save_artifact` run in our harness, over the Harness API's new
 * artifact seam (`artifact.read`, `artifact.write`; Harness API 4), so a session's pinned
 * `runtime` block no longer carries them, and those names are no longer reserved: an author tool
 * may take one, though our harness then refuses the turn. A `tool.completed` of either says kind
 * `harness`. Files reach the model by the harness's decision: a message may name any file
 * within the artifact size limits (no more `422 attachment_unsupported`), `turn.start.model`
 * describes the model the turn uses (what it reads, its window), and the Model Gate only fetches
 * the artifacts a call names and translates the call, refusing a part the provider cannot take
 * (`unsupported_input`). A `ModelCall` has no `outputSchema`: a harness writes its own JSON
 * instruction and parses the answer. The harness names a session's MCP tools, defers them and
 * shapes tool results: `turn.start.mcp` states what the servers listed, raw, and every MCP tool
 * call names its identity (`target: {kind: "mcp", server, tool}`), which tool policy and approval
 * key on (a policy rule with `__` in its `tool` refuses every call). The record refuses an
 * outcome past `limits.recordEntryBytes`. Sessions pinned before protocol 15 must be recreated.
 * The Host serves protocol 15 only.
 * Protocol 14: environment manifests. `/v1/environment-manifests/{name}` holds
 * named, versioned definitions of a kind of Environment, saved like agents (with `If-Match` and
 * `?dryRun=true`), and `PUT /v1/environments/{id}` takes `manifest: "name"` or `"name@n"`. An
 * Environment never changes what it runs after creation: a `PUT` on an existing one may change
 * only its labels and owner guard (`409 environment_immutable`), and its view's `recipe` is now
 * `manifest`. A manifest's `secrets` declares slots: a write sends only the value, and a name it
 * does not declare is `409 secret_not_in_manifest`. An agent manifest's `requires` is checked
 * when a session opens (`409 environment_unsuitable`). Sessions on one Environment run their
 * turns in parallel, so a turn start is no longer `environment_busy` because another
 * session's turn runs, and every egress connection is an `environment.egress` event on the
 * Environment's stream naming the turns that were running; `egress.connection` is gone from
 * session logs and traces. The Host serves protocol 14 only.
 * Protocol 13: the flat agent manifest (v7), a fresh start. A manifest has no capabilities: its
 * instructions, tools, skills and MCP servers are top-level, and a skill or server from an Agent
 * Plugin carries a `plugin` label. A session's pinned manifest carries the Runtime's `runtime`
 * block (the sandbox and its tools, the artifact and skill tools). Tool calls, MCP servers and
 * HTTP calls are named without capability ids, here and on the Harness API (version 3). The Host
 * serves protocol 13 only.
 * Protocol 12: model inputs and files as artifacts. What the Tenant's model reads (`text`,
 * `image`, `pdf`, `office`, `audio`, `video`) is its catalog's input list plus the operator's
 * additions (`PUT /v1/tenant/models/inputs`, a custom endpoint's `settings.inputs`); the catalog
 * and the provider list say it. A message naming a file the model does not read is refused at
 * accept (`422 attachment_unsupported`), with no turn. After its turn a file is a reference line
 * the model reads again with `read_artifact`, which every agent now has. The Host accepts
 * protocol 11 and 12: the change is additive.
 * Protocol 11: Environments, a fresh start. `/v1/environments/{id}` replaces
 * `/v1/sandboxes`: an Environment is one sandbox (kind `virtual`, `pod` or `none`) with a recipe
 * that can change and one vault, written on the Runtime API
 * (`PUT /v1/environments/{id}/secrets/{name}`). Sessions name an `environment` or nothing; the
 * session fields `sandbox`, `vaultIds` and `credentialSelections`, the Tenant's default sandbox,
 * user and installation vaults and `/v1/tenant/vaults` are gone. Error codes, event types, the
 * scope (`environments:write`) and identity-file grants (`environments`) say Environment. An
 * older client is answered `426`.
 * Protocol 10: MCP credential custody leaves OSS. The vault credential type `oauth`, the
 * MCP OAuth connect (`/v1/tenant/vaults/{vaultId}/oauth/start`, `/v1/oauth/callback`) and the
 * credential resolver are gone: a session's MCP servers and HTTP tools reach their credentials
 * through its attached vaults only.
 * Protocol 9: the Runtime API is an OAuth 2.1 resource server (RFC 6750, RFC 9728). A missing
 * or unknown credential is `401 credential_required` or `credential_invalid` with a
 * `WWW-Authenticate: Bearer` challenge instead of the opaque 404, a token missing a scope gets
 * `error="insufficient_scope"`, and `GET /.well-known/oauth-protected-resource` names the trusted
 * issuers. Identity files lose `maxLifetime`: the issuer sets its tokens' lifetimes.
 * Protocol 8: the Runtime and Management APIs (`key_role_mismatch`), and manifest-only agents:
 * manifest v5 and workflow manifest v3, no hooks or flow functions, remote MCP
 * only, and no Action endpoints (`/v1/endpoints` and `/v1/actions/*` answer 404, delivery
 * tokens are gone): an agent's tools are HTTP tools, remote MCP servers, agents and the
 * Runtime's built-ins.
 * Protocol 7: open-source auth. Subject tokens (`POST /v1/tokens`), the access policy,
 * revocations, browser keys (`Nylorun-Key`), the Runtime's own CORS and derived principals are gone; their
 * routes answer 404. Browsers and apps present a trusted issuer's token, servers an operator key.
 * Protocol 6: file artifacts (`/v1/artifacts/**`, Runtime-signed capability links) and user
 * messages with `parts`. Protocol 5: a Host serves one Tenant, and nothing in a request selects
 * it. The Host still accepts protocol 4 (and `Nylorun-Tenant`), 5 and 6 clients on every route
 * that remains; a client that requires `action-endpoints` is refused by the feature check.
 */
export const PROTOCOL_VERSION = 18;
/** What a client of this protocol requires of a Host. */
export const PROTOCOL_FEATURES = [
  "studio-principal",
  "artifacts",
  /**
   * Protocol 8: the Management API (`/v1/tenant/*`) takes management keys only, and the
   * Runtime API application keys only (`key_role_mismatch`); vaults and signing keys are under
   * `/v1/tenant`.
   */
  "management-api",
  /**
   * Protocol 9: credential failures are `401` with a `WWW-Authenticate: Bearer` challenge
   * (`credential_required`, `credential_invalid`), and the Runtime serves its protected resource
   * metadata at `/.well-known/oauth-protected-resource` when it has trusted issuers.
   */
  "resource-server",

  /** Protocol 12: the model catalog and provider list say which inputs each model reads. */
  "model-inputs",
  /**
   * Protocol 13: agent manifest v7 has no capabilities (its instructions, tools, skills and
   * MCP servers are top-level), a session's pinned manifest carries the Runtime's `runtime`
   * block, and tool calls, MCP servers and HTTP calls are named without capability ids.
   */
  "flat-manifest",

  /**
   * Protocol 15: the harness boundary. `read_artifact` and `save_artifact` are our harness's
   * tools, not the Runtime's: a session's pinned `runtime` block no longer carries them, and an
   * author tool may take their names. MCP tools are named by the harness and identified by
   * `{server, tool}`: tool policy rules and approvals name them so.
   */
  "harness-boundary",
  /**
   * Protocol 16: agent manifests (`/v1/agent-manifests/{name}`, v8, with a harness and a runtime
   * section checked against each other at save) and Agents (`/v1/agents/{id}`, kinds `virtual`,
   * `pod` and `none`, each with one vault), made from one manifest version, with a derived
   * `state`; every session runs on an Agent; token callers carry Agent grants checked at every
   * turn start, and `agents:write` lets a subject create, change and delete the Agents it is
   * granted.
   */
  "agents",
  /**
   * Protocol 17: a queue per session. A message to a busy session is queued unless it asks
   * `delivery: "reject"`, and the busy refusal is `409 session_busy`.
   */
  "session-queue",
  /**
   * Protocol 18: model call reads carry their timing and their cost by token kind, and a
   * session's usage the cost by kind and the model time.
   */
  "usage-by-kind",
] as const;
export type ProtocolFeature = (typeof PROTOCOL_FEATURES)[number];
/**
 * Host features no client requires: a client that uses one checks the Host's `/health`
 * for it first. `tenant-fixture-model`: `PUT /v1/tenant/config/seed` accepts
 * `fixtureModel: true` (the Tenant's model calls use the Runtime's fixture model).
 * `transcript-events`: the log carries `message.assistant` and `tool.completed`.
 * `subject-headers`: an application principal may act for a subject with `Nylorun-Subject` and `Nylorun-Scopes`, and the Runtime
 * enforces the scopes and the subject's ownership of sessions. `ag-ui-endpoint`: the Runtime
 * serves AG-UI at `/v1/ag-ui/agents/:agent` for a person named by a trusted issuer's token or
 * by subject headers. `a2a-endpoint`:
 * `POST /v1/a2a/agents/:agent` answers A2A 1.0 JSON-RPC for a subject, and
 * `GET /v1/a2a/agents/:agent/card` returns the agent's card without its interfaces.
 * `sandbox-pods`: Environments of kind `pod` run as agent-sandbox pods on the Tenant's cluster
 * (`nylorun local sandbox enable`), with `POST /v1/environments/{id}/stop` and `/reset`, lifecycle
 * events (`environment.running`, `.suspended`, `.relaunched`, `.lost`, `.reset`, `.failed`) and
 * the Tenant's `placement`.
 * `trusted-issuers`: the Runtime API accepts JWTs from the issuers of the Host's identity file
 * (`NYLORUN_IDENTITY_FILE`) as bearers, from servers and from browsers alike, with the
 * issuer's subject, scopes (and the issuer-only `studio`), agents and Environment grants; `GET
 * /v1/me` reports who any credential is.
 * `environment-setup`: a pod Environment's recipe takes `setup` commands and input `files`, run
 * and copied when its disk is made or reset, before any turn.
 * `environment-disk-versions`: an Environment's disk has versions: `POST
 * /v1/environments/{id}/snapshot` and `/restore`, `GET .../versions`, `DELETE .../versions/{n}`,
 * and `from` on a `PUT` that creates one; a pod whose volume is lost starts again from the latest.
 * `credential-coverage`: `POST /v1/tenant/credential-coverage` (the Management API) says which
 * credential of an Environment's vault each of a saved agent's MCP servers and HTTP tools would
 * get in a session that names that Environment.
 * `tool-calls`: `GET /v1/sessions/{id}/calls/tool` pages a session's tool calls from the
 * effect journal, every `tool.completed` says how its call ended (`status`, `kind`, `server`,
 * `attempts`, `durationMs`), and tool calls are delivered at least once with their effect id as
 * the key (`Idempotency-Key` for HTTP tools, `_meta["nylorun/idempotency-key"]` for MCP tools).
 * `tool-policy`: `GET`/`PUT /v1/tenant/tool-policy` (the Management API) sets which
 * MCP and HTTP tool calls run, wait for a person (`ask`: the turn pauses until `approve`) or are
 * refused (`deny`: `tool.denied`), for every harness; a manifest that sets `approval` is refused.
 * `traces`: `GET /v1/sessions/{id}/turns/{turnId}/trace` answers a turn's spans as OTLP JSON,
 * the spans the Runtime posts to an OTLP collector when one is configured; a command or an AG-UI
 * or A2A request sent with a `traceparent` joins the caller's trace.
 * `gateway-credentials`: a `bearer` or `headers` credential with `via`, written to an Agent's vault,
 * may name the gateway's tool prefix (`toolPrefix`), which the Runtime takes off the tools it lists
 * and puts back on each call.
 * `agent-folders`: `PUT /v1/agent-manifests/{name}` also takes an agent folder by hash
 * (`application/vnd.nylorun.folder+json`), compiles it with `@nylorun/core/folder` and keeps it
 * as the version's source, read at `GET .../versions/{v}/source` and `.../source/files/{path}`.
 * `session-model`: `GET`, `PUT` and `DELETE /v1/sessions/{id}/model` read, choose and clear a
 * session's own model, one of a connected provider's, which its turns use in place of the
 * Tenant's; the Tenant's model does not change.
 * `model-host-identity`: `PUT /v1/tenant/model` takes `auth: { type: "host_identity", project,
 * location }` for `google-vertex`: the model gate calls Agent Platform with the Host's Google
 * Application Default Credentials, when the Host's operator lends them (`NYLORUN_MODEL_HOST_IDENTITY`).
 * `credential-provider`: egress-gate can hand a pod Agent's requests to an outside credential
 * provider the Host's operator names (`NYLORUN_CREDENTIAL_PROVIDER_URL`), which adds the Agent
 * owner's keys: the hosts it lists (exact, or `*.suffix`) pass the allowlist on 443, and each
 * segment's sandbox sees the variables it names, as `nylorun_managed`, a stand-in it names or a
 * plain value. No route changes.
 */
export const OPTIONAL_HOST_FEATURES = [
  "tenant-fixture-model",
  "transcript-events",
  "subject-headers",
  "ag-ui-endpoint",
  "a2a-endpoint",
  /**
   * The Nylorun A2A profile v2 on `a2a-endpoint`: queued follow-ups, push notification configs
   * (signed with Standard Webhooks), `url` file parts in and out (`GET /v1/a2a/files/…`), and
   * the five extensions activated with `A2A-Extensions` (interactions, effects, progress,
   * telemetry, files); the card lists the Runtime's JSON-RPC interface.
   */
  "a2a-profile-v2",
  "sandbox-pods",
  "trusted-issuers",
  "session-reads",
  "calls-export",
  "credential-coverage",
  "tool-calls",
  "environment-setup",
  "environment-disk-versions",
  "tool-policy",
  "traces",
  /** Opt-in artifact metadata pages (`GET /v1/artifacts?limit=…`). */
  "artifact-reads",
  "gateway-credentials",
  "agent-folders",
  "session-model",
  "model-host-identity",
  "credential-provider",
] as const;
export type OptionalHostFeature = (typeof OPTIONAL_HOST_FEATURES)[number];
export interface ProtocolRange {
  min: number;
  max: number;
  features: readonly string[];
}
/**
 * What this Host serves: protocol 16, 17 and 18. Protocol 16 replaced agent definitions and
 * Environments with agent manifests and Agents, so an older client is answered `426` naming the
 * protocol it needs rather than routes it cannot use. Protocol 17 is additive: a protocol 16
 * client's messages default to `delivery: "reject"`. Protocol 18 is additive: a protocol 16 or 17
 * client's usage reads leave out the fields it added.
 */
export const HOST_PROTOCOL: ProtocolRange = {
  min: 16,
  max: 18,
  features: [...PROTOCOL_FEATURES, ...OPTIONAL_HOST_FEATURES],
};
export const DEFINITION_SCHEMA_VERSION = 2;

/**
 * The Tenant a protocol 4 client names on every request. Protocol 5 clients send none: the
 * Host serves one Tenant, and answers a header naming another with the opaque 404.
 */
export const TENANT_HEADER = "Nylorun-Tenant";
export const PROTOCOL_HEADER = "Nylorun-Protocol";
/** The subject an application principal acts for (Host feature `subject-headers`). */
export const SUBJECT_HEADER = "Nylorun-Subject";
/** The space-separated scopes of that subject; required with `Nylorun-Subject`. */
export const SCOPES_HEADER = "Nylorun-Scopes";
/** The session, turn and agent of a call the Runtime makes to an HTTP tool's URL. */
export const SESSION_ID_HEADER = "Nylorun-Session-Id";
export const TURN_ID_HEADER = "Nylorun-Turn-Id";
export const AGENT_ID_HEADER = "Nylorun-Agent-Id";

export const ERROR_CODES = [
  "not_found",
  /** No credential on a route that needs one (protocol 9): `401` with a `Bearer` challenge. */
  "credential_required",
  /**
   * A key the Tenant does not know, or a token no trusted issuer signed or that fails its checks
   * (protocol 9): `401` with `WWW-Authenticate: Bearer error="invalid_token"`. The reason is
   * logged, never sent.
   */
  "credential_invalid",
  "protocol_unsupported",
  "host_rejected",
  "origin_rejected",
  "unsupported_media_type",
  "connection_missing",
  "incompatible_host",
  "subject_invalid",
  "scope_required",
  /**
   * A known key on the other API (protocol 8): an application key on the Management API
   * (`/v1/tenant/*`), or a management key on the Runtime API. The message names the key's API.
   */
  "key_role_mismatch",
  "token_expired",
  "limit_exceeded",
  /** A request the Runtime refuses for a reason the message gives. */
  "request_rejected",
  /** A request the Host could not read: headers, body or query. */
  "invalid_request",
  /** A route that acts for a person was called without one (`Nylorun-Subject`). */
  "subject_required",
  /** A token caller's Agent grants do not reach the Agent. */
  "agent_not_granted",
  /**
   * A message to a session whose turn runs, or that waits on an approval, an answer or an
   * uncertain call, sent with `delivery: "reject"` (protocol 17): `409`. Without it the message is
   * queued.
   */
  "session_busy",
  /**
   * The session already holds the Runtime limit `sessionQueuedMessages` queued messages
   * (protocol 17): `429`. They start a turn when the running one ends.
   */
  "queue_full",
  /**
   * `POST /v1/agents/{id}/triggers/{triggerId}/resume` on an `at` trigger whose time has passed:
   * `409`. Save a manifest version with a new time.
   */
  "trigger_expired",
  /** A signed delivery to a paused webhook trigger: `409`; nothing runs. */
  "trigger_paused",
  /**
   * A memory write whose `content_sha256` precondition no longer holds, or a path a folder or
   * another memory already holds: `409`. Read the memory again and write on top.
   */
  "memory_conflict",
  /** Disk work (snapshot, restore, stop, reset) while a turn runs, or a turn while a disk copy runs. */
  "agent_busy",
  /** The Agent is gone, or its kind cannot run on this Runtime. */
  "agent_unavailable",
  /** The Tenant's placement keeps this session's harness off the host its Agent needs. */
  "placement_refused",
  /** A pod Agent's volume or node is gone: only `POST /v1/agents/{id}/reset` brings it back. */
  "agent_lost",
  /**
   * The Agent names an owner (`owner`) other than the session's owner: `403` to an
   * application key; a caller acting for a person gets the opaque `404`.
   */
  "agent_owner_mismatch",
  /**
   * The session's Agent runs another harness than the one the session pinned when it opened: an
   * Agent's harness is fixed for its life, so its id was deleted and made again from a manifest
   * with another harness. Open a new session.
   */
  "harness_mismatch",
  /**
   * The session is closed: it was opened before protocol 11 (its history stays readable), so
   * open a new session that names an Environment.
   */
  "session_closed",
  /**
   * A trusted issuer's token names a key the Runtime has not seen, and the issuer's JWKS cannot
   * be fetched now (Host feature `trusted-issuers`): retry later. Keys already fetched keep working.
   */
  "issuer_unavailable",
  /**
   * A definition names definition files the Runtime does not hold: upload each
   * with `PUT /v1/files/sha256:<hex>` first. `details.missing` lists their hashes.
   */
  "definition_files_missing",
  /**
   * Not an HTTP answer: the code of a tool error the model sees when an MCP server or HTTP tool
   * answered `401`. The vault's credential (or none) was rejected; the call is not retried.
   */
  "credential_rejected",
  /**
   * `POST /v1/tenant/mcp/preview` could not list the server's tools: `502`, with
   * `details.failure` the code a tool call would have failed with (`mcp.unreachable` for an
   * address the Host refuses, a connection that failed or a server silent past 15 s;
   * `mcp.forbidden`, `mcp.status`, `mcp.error`).
   */
  "mcp_preview_failed",
  /**
   * An Environment's credentials would be ambiguous: `409` at the secret write. Two
   * `environment_secret` credentials would be bound to one host, or two `bearer` or `headers`
   * credentials to one URL.
   */
  "credential_conflict",
  /**
   * A move of an existing Agent (`PUT /v1/agents/{id}`) would change what is fixed for
   * its life: its manifest's name, its kind, its harness or its storage. `409`, with each in
   * `details.fields`. Fork it into a new Agent (`POST /v1/agents/{id}/fork`) instead.
   */
  "agent_fixed_field",
  /**
   * A secret write named a secret the Agent's manifest does not declare: `409`. Add the
   * slot to the manifest's runtime section and move the Agent to the new version.
   */
  "secret_not_in_manifest",
  /**
   * An agent manifest whose harness and runtime sections do not fit each other (protocol 16):
   * `422` when it is saved. `details.gaps` names each gap: a custom harness off a pod, a
   * credential that is no declared slot of the right type, a sandbox the runtime does not give.
   */
  "manifest_inconsistent",
  /** No agent manifest has this name, or no version with this number. */
  "manifest_not_found",
  /** An agent manifest some Agent was made from cannot be deleted: `409`. */
  "manifest_in_use",
  /**
   * `If-Match` named a version that is no longer the latest: `412`. Read the manifest
   * again, or save without `If-Match` (the CLI's `--if-match`, the SDK's `ifMatch`).
   */
  "manifest_changed",
  /**
   * An agent folder that does not compile (track T6): `422` when it is saved or planned.
   * `details.diagnostics` names every problem, each with its file and, for parse and schema
   * errors, its line and column.
   */
  "folder_invalid",
  "internal_error",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

/** Crockford Base32 alphabet (lowercase); excludes i, l, o, u. */
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";
export const TENANT_ID_PATTERN = /^tn_[0-9a-hjkmnp-tv-z]{26}$/;
export const PRINCIPAL_ID_PATTERN = /^pr_[0-9a-hjkmnp-tv-z]{26}$/;
/** A Tenant signing key's id, the `kid` of the tokens it signs (capability links, run tokens). */
export const SIGNING_KEY_ID_PATTERN = /^sk_[0-9a-hjkmnp-tv-z]{26}$/;
/** A file artifact's id (protocol 6). */
export const ARTIFACT_ID_PATTERN = /^af_[0-9a-hjkmnp-tv-z]{26}$/;
/**
 * An application key's id: an operator key's name, which names its client (e.g. `backend`).
 * `studio` is reserved for the key Studio derives from the admin key.
 * An identifier's grammar is the protocol's: it crosses the Runtime API, tokens and grants
 * and means the same in every installation, so its length is a constant of protocol 15, not a
 * setting.
 */
export const APPLICATION_KEY_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * What a key reaches (protocol 8). `application`: the Runtime API, for the whole Tenant or for
 * one subject. `management`: the Management API (`/v1/tenant/*`), as itself only. `studio`: the
 * key Studio derives from the admin key, which reaches both.
 */
export const KEY_ROLES = ["application", "management", "studio"] as const;
export type KeyRole = (typeof KEY_ROLES)[number];
/** The management key a Host registers from `NYLORUN_MANAGEMENT_KEY_FILE` at start. */
export const BOOTSTRAP_KEY_ID = "bootstrap";

export function isTenantId(value: unknown): value is string {
  return typeof value === "string" && TENANT_ID_PATTERN.test(value);
}

export function isPrincipalId(value: unknown): value is string {
  return typeof value === "string" && PRINCIPAL_ID_PATTERN.test(value);
}

function encodeTime(ms: number): string {
  let value = Math.floor(ms);
  if (!Number.isFinite(value) || value < 0) value = 0;
  // ULID time component is 48 bits.
  value = value % 2 ** 48;
  let out = "";
  for (let i = 0; i < 10; i++) {
    out = CROCKFORD[value % 32]! + out;
    value = Math.floor(value / 32);
  }
  return out;
}

function encodeRandom(): string {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  let out = "";
  // 80 bits → 16 Crockford chars (5 bits each).
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += CROCKFORD[(buffer >> bits) & 31]!;
    }
  }
  return out;
}

let lastTime = -1;
let lastRandom = "";

function newPrefixedId(
  prefix: "tn_" | "pr_" | "sk_" | "af_",
  now?: number,
): string {
  const ms = now ?? Date.now();
  const time = encodeTime(ms);
  let random = encodeRandom();
  if (ms === lastTime && lastRandom !== "" && random <= lastRandom) {
    random = incrementCrockford(lastRandom);
  }
  lastTime = ms;
  lastRandom = random;
  return `${prefix}${time}${random}`;
}

/**
 * Lowercase Crockford ULID with `tn_` prefix; 48-bit time + 80-bit CSPRNG.
 * Same-millisecond calls stay lexicographically monotonic by bumping the random
 * component when the clock does not advance.
 */
export function newTenantId(now?: number): string {
  return newPrefixedId("tn_", now);
}

/** Principal id: `pr_` + lowercase Crockford ULID (same generator as tenants). */
export function newPrincipalId(now?: number): string {
  return newPrefixedId("pr_", now);
}

/** Signing key id: `sk_` + lowercase Crockford ULID (same generator as tenants). */
export function newSigningKeyId(now?: number): string {
  return newPrefixedId("sk_", now);
}

/** Artifact id: `af_` + lowercase Crockford ULID. */
export function newArtifactId(now?: number): string {
  return newPrefixedId("af_", now);
}

export function isArtifactId(value: unknown): value is string {
  return typeof value === "string" && ARTIFACT_ID_PATTERN.test(value);
}

type SemVerParts = {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
};

function parseSemVer(version: string): SemVerParts | null {
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(
      version,
    );
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split(".") : [],
  };
}

function compareIdentifiers(a: string, b: string): -1 | 0 | 1 {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const aValue = BigInt(a);
    const bValue = BigInt(b);
    if (aValue < bValue) return -1;
    if (aValue > bValue) return 1;
    return 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * SemVer 2.0 precedence, including prereleases. Build metadata is ignored.
 * Returns -1 when a < b, 0 when equal, 1 when a > b.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = parseSemVer(a);
  const right = parseSemVer(b);
  if (!left || !right) {
    if (a === b) return 0;
    return a < b ? -1 : 1;
  }
  if (left.major !== right.major)
    return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor)
    return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch)
    return left.patch < right.patch ? -1 : 1;
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0;
  if (left.prerelease.length === 0) return 1;
  if (right.prerelease.length === 0) return -1;
  const limit = Math.max(left.prerelease.length, right.prerelease.length);
  for (let i = 0; i < limit; i++) {
    const aId = left.prerelease[i];
    const bId = right.prerelease[i];
    if (aId === undefined) return -1;
    if (bId === undefined) return 1;
    const order = compareIdentifiers(aId, bId);
    if (order !== 0) return order;
  }
  return 0;
}

function incrementCrockford(value: string): string {
  const chars = [...value];
  for (let i = chars.length - 1; i >= 0; i--) {
    const index = CROCKFORD.indexOf(chars[i]!);
    if (index < 0) continue;
    if (index < 31) {
      chars[i] = CROCKFORD[index + 1]!;
      return chars.join("");
    }
    chars[i] = CROCKFORD[0]!;
  }
  return encodeRandom();
}

export type Compatibility =
  | { ok: true }
  | { ok: false; reason: "version"; client: number; host: ProtocolRange }
  | {
      ok: false;
      reason: "feature";
      missing: readonly string[];
      host: ProtocolRange;
    };

export function checkCompatibility(
  client: { version: number; required: readonly string[] },
  host: ProtocolRange,
): Compatibility {
  if (client.version < host.min || client.version > host.max) {
    return { ok: false, reason: "version", client: client.version, host };
  }
  const advertised = new Set(host.features);
  const missing = client.required.filter((feature) => !advertised.has(feature));
  if (missing.length > 0) {
    return { ok: false, reason: "feature", missing, host };
  }
  return { ok: true };
}
