import type { Migration } from "./index.js";

/**
 * The model usage ledger (P1.3): one row per model call a gate served, written after the call.
 * A second row for the same effect (a call the gate ran again after a gateway restart) is
 * flagged `duplicate`; both were billed. Budgets read their spend from it.
 */
export const modelUsage: Migration = {
  version: 10,
  name: "model_usage",
  up: (s) => `
    CREATE TABLE ${s}.model_usage (
      id text COLLATE "C" PRIMARY KEY,
      effect_key text COLLATE "C" NOT NULL,
      session_id text COLLATE "C" NOT NULL,
      turn_id text COLLATE "C" NOT NULL,
      agent_id text COLLATE "C" NOT NULL,
      provider text,
      model text,
      input_tokens integer NOT NULL,
      output_tokens integer NOT NULL,
      total_tokens integer NOT NULL,
      cached_tokens integer NOT NULL,
      cache_write_tokens integer NOT NULL,
      reasoning_tokens integer NOT NULL,
      cost_usd double precision NOT NULL,
      duplicate boolean NOT NULL,
      created_at text NOT NULL
    );
    CREATE INDEX model_usage_effect ON ${s}.model_usage (effect_key);
    CREATE INDEX model_usage_agent ON ${s}.model_usage (agent_id, created_at);
    CREATE INDEX model_usage_turn ON ${s}.model_usage (turn_id);
    CREATE INDEX model_usage_created ON ${s}.model_usage (created_at);
  `,
};
