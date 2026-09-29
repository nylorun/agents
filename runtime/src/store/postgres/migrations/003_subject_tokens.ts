import type { Migration } from "./index.js";

/**
 * Subject tokens (Host feature `subject-tokens`): the Tenant's signing keys (private halves
 * sealed with the vault KEK, like credentials), each subject's revocation epoch, each
 * subject's turn bucket, and an index for counting a subject's sessions by status.
 */
export const subjectTokens: Migration = {
  version: 3,
  name: "subject_tokens",
  up: (s) => `
    CREATE TABLE ${s}.signing_keys (
      id text COLLATE "C" PRIMARY KEY,
      state text NOT NULL CHECK (state IN ('standby', 'current', 'previous', 'revoked')),
      alg text NOT NULL CHECK (alg = 'ES256'),
      public_jwk text NOT NULL,
      kek_id text NOT NULL,
      nonce bytea NOT NULL,
      ciphertext bytea NOT NULL,
      wrapped_dek bytea NOT NULL,
      created_at text NOT NULL,
      activated_at text,
      retired_at text,
      revoked_at text
    );
    CREATE UNIQUE INDEX signing_keys_one_standby ON ${s}.signing_keys (state) WHERE state = 'standby';
    CREATE UNIQUE INDEX signing_keys_one_current ON ${s}.signing_keys (state) WHERE state = 'current';
    CREATE UNIQUE INDEX signing_keys_one_previous ON ${s}.signing_keys (state) WHERE state = 'previous';

    CREATE TABLE ${s}.subject_epochs (
      subject text COLLATE "C" PRIMARY KEY,
      epoch bigint NOT NULL,
      revoked_at text NOT NULL
    );

    CREATE TABLE ${s}.subject_usage (
      subject text COLLATE "C" PRIMARY KEY,
      turn_tokens double precision NOT NULL,
      refilled_at text NOT NULL
    );

    CREATE INDEX sessions_owner_status ON ${s}.sessions (owner_user_id, status);
  `,
};
