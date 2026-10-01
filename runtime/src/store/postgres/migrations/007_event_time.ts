import type { Migration } from "./index.js";

/**
 * Protocol 4 puts events on the `nylorun.event/2` envelope, where `createdAt` is `time`. The
 * outbox's `created_at` (its age, for relay lag) is generated from either, so rows written
 * before the upgrade keep theirs.
 */
export const eventTime: Migration = {
  version: 7,
  name: "event_time",
  up: (s) => `
    ALTER TABLE ${s}.outbox DROP COLUMN created_at;
    ALTER TABLE ${s}.outbox ADD COLUMN created_at text COLLATE "C"
      GENERATED ALWAYS AS (coalesce(${s}.doc(body)->>'time', ${s}.doc(body)->>'createdAt')) STORED;
  `,
};
