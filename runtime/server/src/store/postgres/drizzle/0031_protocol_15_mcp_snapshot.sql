-- Protocol 15: the harness names a session's MCP tools and decides which to defer, so the
-- session pins what its servers listed, raw (`snapshotSchemaVersion` 2), and every MCP call names
-- its tool by `{server, tool}`. A session that pinned the former snapshot (model-facing names,
-- deferral decided by core) cannot run its next turn: each still open is closed
-- (`session_closed`) and its history stays readable. The others carry over.
UPDATE "nylorun"."sessions" SET "body" = ("body"::jsonb || '{"closedReason":"protocol_15"}'::jsonb)::json
WHERE nylorun.doc("body") ->> 'closedReason' IS NULL
  AND nylorun.doc("body") -> 'mcpSnapshot' ->> 'snapshotSchemaVersion' = '1';
