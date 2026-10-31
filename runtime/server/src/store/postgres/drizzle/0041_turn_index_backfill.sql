-- Custom SQL (a data change): the turn index (0040) for the turns the record already holds. Each
-- turn's row is what `Tx.event` would have written for its lifecycle events (`command.message`,
-- `command.approve`, `command.respond`, `turn.paused`, `turn.completed`, `turn.failed`,
-- `turn.cancelled`): its status from the last of them (and, paused, what its first open
-- interaction asks for), its start from the first, and the queued messages it took. Its session's
-- Agent, owner and A2A context come from the session row as it is now. Rows written from here on
-- come from `Tx.event`, in the transaction of the event.
WITH lifecycle AS (
	SELECT "session_id", "seq", "type", nylorun.doc("body") AS doc
	FROM "nylorun_streams"."session_events"
	WHERE "type" IN (
		'command.message', 'command.approve', 'command.respond',
		'turn.paused', 'turn.completed', 'turn.failed', 'turn.cancelled'
	)
), turned AS (
	SELECT "session_id", doc->>'turnId' AS turn_id, "seq", "type", doc
	FROM lifecycle
	WHERE doc->>'turnId' IS NOT NULL
), bounds AS (
	SELECT "session_id", turn_id, min("seq") AS first_seq,
		min(doc->>'time') AS started_at,
		coalesce(
			array_remove(
				array_agg(doc->'payload'->>'queuedMessageId' ORDER BY "seq")
					FILTER (WHERE "type" = 'command.message'),
				NULL
			),
			'{}'
		) AS queued_message_ids
	FROM turned
	GROUP BY "session_id", turn_id
), latest AS (
	-- A turn's further messages (a queued batch) change nothing but its queued messages.
	SELECT DISTINCT ON (t."session_id", t.turn_id) t."session_id", t.turn_id, t."seq", t."type", t.doc
	FROM turned t
	JOIN bounds b ON b."session_id" = t."session_id" AND b.turn_id = t.turn_id
	WHERE NOT (t."type" = 'command.message' AND t."seq" > b.first_seq)
	ORDER BY t."session_id", t.turn_id, t."seq" DESC
)
INSERT INTO "nylorun"."turns" (
	"session_id", "turn_id", "agent_id", "owner_user_id", "a2a_context_id", "status",
	"started_at", "ended_at", "changed_at", "totals", "waiting_for", "queued_message_ids",
	"first_seq", "last_seq"
)
SELECT
	b."session_id",
	b.turn_id,
	coalesce(s."agent_id", ''),
	s."owner_user_id",
	nylorun.doc(s."body")->'info'->'a2a'->>'contextId',
	CASE l."type"
		WHEN 'turn.completed' THEN 'completed'
		WHEN 'turn.failed' THEN 'failed'
		WHEN 'turn.cancelled' THEN 'cancelled'
		WHEN 'turn.paused' THEN 'paused'
		ELSE 'running'
	END,
	b.started_at,
	CASE WHEN l."type" IN ('turn.completed', 'turn.failed', 'turn.cancelled') THEN l.doc->>'time' END,
	l.doc->>'time',
	CASE WHEN l."type" IN ('turn.completed', 'turn.failed', 'turn.cancelled')
		AND jsonb_typeof(l.doc->'payload'->'totals'->'steps') = 'number'
		AND jsonb_typeof(l.doc->'payload'->'totals'->'tokens') = 'number'
		AND jsonb_typeof(l.doc->'payload'->'totals'->'costUsd') = 'number'
		THEN json_build_object(
			'steps', l.doc->'payload'->'totals'->'steps',
			'tokens', l.doc->'payload'->'totals'->'tokens',
			'costUsd', l.doc->'payload'->'totals'->'costUsd'
		) END,
	CASE WHEN l."type" = 'turn.paused' AND jsonb_typeof(l.doc->'payload'->'interactions') = 'array' THEN (
		SELECT CASE
			WHEN x.e->'interaction'->>'kind' = 'connection'
				OR x.e->'interaction'->'metadata'->>'kind' = 'connection' THEN 'connection'
			WHEN x.e->'interaction'->>'kind' = 'approval' THEN 'approval'
			ELSE 'question'
		END
		FROM jsonb_array_elements(l.doc->'payload'->'interactions') WITH ORDINALITY AS x(e, i)
		WHERE (x.e->>'status' IS NULL OR x.e->>'status' = 'interaction')
			AND jsonb_typeof(x.e->'interaction'->'id') = 'string'
		ORDER BY x.i
		LIMIT 1
	) END,
	b.queued_message_ids,
	b.first_seq,
	l."seq"
FROM bounds b
JOIN latest l ON l."session_id" = b."session_id" AND l.turn_id = b.turn_id
LEFT JOIN "nylorun"."sessions" s ON s."id" = b."session_id";
