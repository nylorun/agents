import type { Migration } from "./index.js";

/**
 * The session owner (`ownerUserId`) as a stored generated column with an index, so a request
 * acting for a subject lists only that subject's sessions. Not the lease column `owner`.
 */
export const sessionOwner: Migration = {
  version: 2,
  name: "session_owner",
  up: (s) => `
    ALTER TABLE ${s}.sessions
      ADD COLUMN owner_user_id text GENERATED ALWAYS AS (${s}.doc(body)->>'ownerUserId') STORED;
    CREATE INDEX sessions_owner_user ON ${s}.sessions (owner_user_id);
  `,
};
