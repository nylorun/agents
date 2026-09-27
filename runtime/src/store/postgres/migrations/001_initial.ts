import type { Migration } from "./index.js";

/**
 * The first Postgres Tenant schema.
 *
 * - `tenant` holds the Tenant envelope (one row).
 * - Document tables keep `id text primary key, body json`. The fields typed
 *   queries filter on are stored generated columns with indexes. Ids and
 *   timestamps compared as text use `COLLATE "C"`, so ordering is by code
 *   point, like the in-memory fake, whatever the database collation.
 * - Bodies are `json`, not `jsonb`, so every string round-trips exactly as
 *   `JSON.stringify` wrote it. `jsonb` rejects the escapes `\u0000` (`22P05`)
 *   and unpaired surrogates (`\ud800`), which tool output can contain and
 *   which SQLite and the in-memory store accept. `json` stores the text
 *   verbatim and checks only its syntax. The generated columns read the body
 *   through `doc(body)`, which casts to `jsonb` after replacing those two
 *   escapes with `\ufffd`: the stored body is untouched, and only an indexed
 *   field that itself contained one (never an id, status or timestamp) would
 *   see U+FFFD. Bodies with no `\u` escape at all take the plain cast. Queries
 *   never apply `->`/`->>` to a `json` body (Postgres de-escapes the whole text
 *   and fails on the same escapes); they read generated columns.
 * - `sessions` carries the store-managed `next_event_seq` and ownership
 *   columns (`owner`, `epoch`, `owner_expires_at`), which are never in `body`.
 * - `outbox(session_id, seq, body)` holds committed, unrelayed events.
 * - Executors, principals, vault and settings keep typed columns. Vault
 *   ciphertext is `bytea` columns, never inside a JSON body.
 */
export const initial: Migration = {
  version: 1,
  name: "initial",
  up: (s) => `
    CREATE FUNCTION ${s}.doc(body json) RETURNS jsonb
    LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
      SELECT CASE WHEN strpos(body::text, '\\u') = 0 THEN body::jsonb
        ELSE regexp_replace(
          body::text,
          '(?<!\\\\)((?:\\\\\\\\)*)\\\\u(0000|[dD][89a-fA-F][0-9a-fA-F]{2})',
          '\\1\\\\ufffd',
          'g'
        )::jsonb
      END
    $$;

    CREATE TABLE ${s}.tenant (
      id text COLLATE "C" PRIMARY KEY,
      name text NOT NULL,
      created_at text NOT NULL,
      updated_at text NOT NULL,
      schema_version integer NOT NULL,
      singleton boolean NOT NULL DEFAULT true UNIQUE CHECK (singleton)
    );

    CREATE TABLE ${s}.definitions (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL
    );

    CREATE TABLE ${s}.sessions (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL,
      status text GENERATED ALWAYS AS (${s}.doc(body)->>'status') STORED,
      agent_id text GENERATED ALWAYS AS (${s}.doc(body)->>'agentId') STORED,
      stream_incarnation text GENERATED ALWAYS AS (${s}.doc(body)->>'streamIncarnation') STORED,
      next_event_seq bigint NOT NULL DEFAULT 0,
      owner text,
      epoch bigint NOT NULL DEFAULT 0,
      owner_expires_at timestamptz
    );
    CREATE INDEX sessions_status ON ${s}.sessions (status, owner_expires_at);
    CREATE INDEX sessions_agent ON ${s}.sessions (agent_id);

    CREATE TABLE ${s}.commands (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL
    );

    CREATE TABLE ${s}.checkpoints (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL
    );

    CREATE TABLE ${s}.effects (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL,
      session_id text GENERATED ALWAYS AS (${s}.doc(body)->'request'->>'sessionId') STORED,
      turn_id text GENERATED ALWAYS AS (${s}.doc(body)->'request'->>'turnId') STORED,
      kind text GENERATED ALWAYS AS (${s}.doc(body)->'request'->>'kind') STORED,
      status text GENERATED ALWAYS AS (${s}.doc(body)->>'status') STORED
    );
    CREATE INDEX effects_session ON ${s}.effects (session_id, turn_id, status);
    CREATE INDEX effects_status ON ${s}.effects (status, kind);

    CREATE TABLE ${s}.actions (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL,
      session_id text GENERATED ALWAYS AS (${s}.doc(body)->>'sessionId') STORED,
      turn_id text GENERATED ALWAYS AS (${s}.doc(body)->>'turnId') STORED,
      agent_id text GENERATED ALWAYS AS (${s}.doc(body)->>'agentId') STORED,
      status text GENERATED ALWAYS AS (${s}.doc(body)->>'status') STORED,
      kind text GENERATED ALWAYS AS (${s}.doc(body)->>'kind') STORED,
      lease_expires_at text GENERATED ALWAYS AS (${s}.doc(body)->>'leaseExpiresAt') STORED
    );
    CREATE INDEX actions_session ON ${s}.actions (session_id, turn_id, status);
    CREATE INDEX actions_agent ON ${s}.actions (agent_id, status);
    CREATE INDEX actions_status ON ${s}.actions (status, kind);
    CREATE INDEX actions_lease ON ${s}.actions (status, lease_expires_at);

    CREATE TABLE ${s}.sandboxes (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL
    );

    CREATE TABLE ${s}.links (
      id text COLLATE "C" PRIMARY KEY,
      body json NOT NULL,
      workflow_session_id text GENERATED ALWAYS AS (${s}.doc(body)->>'workflowSessionId') STORED
    );
    CREATE INDEX links_workflow ON ${s}.links (workflow_session_id);

    CREATE TABLE ${s}.outbox (
      session_id text COLLATE "C" NOT NULL,
      seq bigint NOT NULL,
      body json NOT NULL,
      created_at text COLLATE "C" GENERATED ALWAYS AS (${s}.doc(body)->>'createdAt') STORED,
      PRIMARY KEY (session_id, seq)
    );

    CREATE TABLE ${s}.executors (
      agent_id text COLLATE "C" PRIMARY KEY,
      token_hash text NOT NULL UNIQUE,
      implementation_version text NOT NULL,
      manifest_hash text,
      principal_id text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    CREATE TABLE ${s}.principals (
      id text COLLATE "C" PRIMARY KEY,
      role text NOT NULL,
      token_hash text NOT NULL UNIQUE,
      idempotency_key text,
      created_at text NOT NULL
    );

    CREATE TABLE ${s}.vaults (
      id text COLLATE "C" PRIMARY KEY,
      name text NOT NULL,
      owner_user_id text NOT NULL,
      metadata_json text,
      created_at text COLLATE "C" NOT NULL,
      scope text NOT NULL DEFAULT 'user' CHECK (scope IN ('user', 'host'))
    );
    CREATE INDEX vaults_owner ON ${s}.vaults (owner_user_id, created_at, id);
    CREATE UNIQUE INDEX vaults_one_host ON ${s}.vaults (scope) WHERE scope = 'host';

    CREATE TABLE ${s}.vault_credentials (
      id text COLLATE "C" PRIMARY KEY,
      vault_id text NOT NULL REFERENCES ${s}.vaults (id) ON DELETE CASCADE,
      name text NOT NULL,
      type text NOT NULL,
      binding_json text NOT NULL,
      expires_at text,
      created_at text COLLATE "C" NOT NULL,
      rotated_at text,
      kek_id text NOT NULL,
      nonce bytea NOT NULL,
      ciphertext bytea NOT NULL,
      wrapped_dek bytea NOT NULL
    );
    CREATE INDEX vault_credentials_vault ON ${s}.vault_credentials (vault_id, created_at, id);

    CREATE TABLE ${s}.vault_audit (
      ord bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
      id text NOT NULL UNIQUE,
      at text NOT NULL,
      actor text NOT NULL,
      action text NOT NULL,
      vault_id text,
      credential_id text,
      session_id text,
      target text,
      outcome text NOT NULL
    );
    CREATE INDEX vault_audit_vault ON ${s}.vault_audit (vault_id, ord);

    CREATE TABLE ${s}.vault_idempotency (
      id text PRIMARY KEY,
      body_hash text NOT NULL,
      response text NOT NULL
    );

    CREATE TABLE ${s}.tenant_settings (
      key text PRIMARY KEY,
      value text NOT NULL
    );
  `,
};
