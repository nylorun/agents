-- Protocol 13: manifest 7, flat (no capabilities), with the Runtime's tools in a `runtime` block.
-- A fresh start for sessions: one opened before protocol 13 pinned a manifest 5 or 6, which the
-- engine no longer runs, so it is closed (`session_closed`) and its history stays readable. No
-- column changes: tool calls are read from the effect journal's documents, whose old
-- `capabilityId` field is ignored.
UPDATE "nylorun"."sessions" SET "body" = ("body"::jsonb || '{"closedReason":"protocol_13"}'::jsonb)::json
WHERE nylorun.doc("body") ->> 'closedReason' IS NULL;
