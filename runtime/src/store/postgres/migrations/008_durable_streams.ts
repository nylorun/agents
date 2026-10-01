import type { Migration } from "./index.js";

/**
 * Durable Streams v1 (Durable Streams §18.1): session events move from the Tenant's outbox to
 * the shared record (`nylorun_streams`), and stream names lose their incarnation.
 *
 * **A fresh start for session data.** A Tenant that has sessions loses them, with their
 * commands, checkpoints, effects, Actions, links, outbox and turn buckets, as a
 * sessions-scope reset does; settings, agents, Action endpoints, keys, policy and vaults stay.
 * It moves to basin generation 1, and generation 0 (the basin holding the old streams) is
 * retired, so the Runtime deletes it when the Tenant opens. A Tenant without sessions stays at
 * generation 0: its basin holds no session stream it could collide with.
 */
export const durableStreams: Migration = {
  version: 8,
  name: "durable_streams",
  up: (s) => `
    ALTER TABLE ${s}.tenant
      ADD COLUMN basin_generation integer NOT NULL DEFAULT 0,
      ADD COLUMN retired_generations integer[] NOT NULL DEFAULT '{}';
    UPDATE ${s}.tenant SET basin_generation = 1, retired_generations = '{0}'
      WHERE EXISTS (SELECT 1 FROM ${s}.sessions);

    DELETE FROM ${s}.links;
    DELETE FROM ${s}.actions;
    DELETE FROM ${s}.effects;
    DELETE FROM ${s}.checkpoints;
    DELETE FROM ${s}.commands;
    DELETE FROM ${s}.sessions;
    DELETE FROM ${s}.subject_usage;
    DROP TABLE ${s}.outbox;

    ALTER TABLE ${s}.sessions
      DROP COLUMN stream_incarnation,
      DROP COLUMN next_event_seq;
  `,
};
