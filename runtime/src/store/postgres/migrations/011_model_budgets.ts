import type { Migration } from "./index.js";

/**
 * Model budgets (P1.3): hard caps the model gate checks before each call. One row per scope:
 * `turn` and `tenant` use `*`, `agent` the agent id. `period` is the UTC `day` or `month` the
 * spend is counted over, or null for `turn`.
 */
export const modelBudgets: Migration = {
  version: 11,
  name: "model_budgets",
  up: (s) => `
    CREATE TABLE ${s}.model_budgets (
      scope text NOT NULL,
      scope_id text COLLATE "C" NOT NULL,
      period text,
      limit_usd double precision,
      limit_tokens bigint,
      updated_at text NOT NULL,
      PRIMARY KEY (scope, scope_id)
    );
  `,
};
