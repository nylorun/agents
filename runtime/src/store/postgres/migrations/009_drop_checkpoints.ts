import type { Migration } from "./index.js";

/**
 * Drops the `checkpoints` table (blueprint P0.2). Every settle wrote a copy of the session's
 * checkpoint there and nothing ever read it: the checkpoint the Runtime resumes from lives on
 * the session row, which is unchanged.
 */
export const dropCheckpoints: Migration = {
  version: 9,
  name: "drop_checkpoints",
  up: (s) => `
    DROP TABLE IF EXISTS ${s}.checkpoints;
  `,
};
