import type { Migration } from "./index.js";

/**
 * Protocol 3 removes executors: Actions are only delivered to Action endpoints.
 *
 * An Action an executor had claimed becomes `delivering` with a deadline that has already
 * passed, so the next sweep applies the delivery loss rule to it (`delivery.ts` `loseAction`):
 * a tool becomes `uncertain` with its `action.uncertain` event, and a hook, `fn` or `verify` is
 * delivered again. Open Actions lose the executor-only `claimId` and `leaseExpiresAt`; settled
 * ones are never delivered again and keep them.
 */
export const dropExecutors: Migration = {
  version: 6,
  name: "drop_executors",
  up: (s) => `
    DROP INDEX ${s}.actions_lease;
    ALTER TABLE ${s}.actions DROP COLUMN lease_expires_at;

    UPDATE ${s}.actions
      SET body = (
        ${s}.doc(body) - 'claimId' - 'leaseExpiresAt'
          || jsonb_build_object(
            'status', 'delivering',
            'deadlineAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
      )::json
      WHERE status = 'claimed';
    UPDATE ${s}.actions
      SET body = (${s}.doc(body) - 'claimId' - 'leaseExpiresAt')::json
      WHERE status IN ('pending', 'delivering');

    DROP TABLE ${s}.executors;
  `,
};
