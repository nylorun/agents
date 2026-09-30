import type { Migration } from "./index.js";

/**
 * Action endpoints: where the Runtime delivers each agent's Actions over HTTP, with the health
 * recent deliveries report, and the deadline of an Action being delivered.
 */
export const actionEndpoints: Migration = {
  version: 5,
  name: "action_endpoints",
  up: (s) => `
    CREATE TABLE ${s}.endpoints (
      agent_id text COLLATE "C" PRIMARY KEY,
      url text NOT NULL,
      implementation_version text NOT NULL,
      manifest_hash text,
      timeout_ms integer NOT NULL,
      max_concurrent integer NOT NULL,
      principal_id text,
      last_delivery_at text,
      last_success_at text,
      last_error_code text,
      last_error_message text,
      consecutive_failures integer NOT NULL DEFAULT 0,
      served_implementation_version text,
      served_manifest_hash text,
      created_at text NOT NULL,
      updated_at text NOT NULL
    );

    ALTER TABLE ${s}.actions
      ADD COLUMN deadline_at text GENERATED ALWAYS AS (${s}.doc(body)->>'deadlineAt') STORED;
    CREATE INDEX actions_deadline ON ${s}.actions (status, deadline_at);
  `,
};
