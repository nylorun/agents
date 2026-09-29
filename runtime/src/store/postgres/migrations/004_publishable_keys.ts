import type { Migration } from "./index.js";

/**
 * Publishable keys (Host feature `browser-access`): public by design, so stored as they are,
 * with the origins a browser may use each from.
 */
export const publishableKeys: Migration = {
  version: 4,
  name: "publishable_keys",
  up: (s) => `
    CREATE TABLE ${s}.publishable_keys (
      id text COLLATE "C" PRIMARY KEY,
      key text COLLATE "C" NOT NULL UNIQUE,
      name text NOT NULL UNIQUE,
      origins_json text NOT NULL,
      created_at text NOT NULL,
      revoked_at text
    );
  `,
};
