-- Protocol 15: the harness writes the model's instructions and defines the sandbox and skill
-- tools, so the manifest schema refuses a pinned `runtime` block, and a session pins its
-- definition as registered. A fresh start for the agent sessions that still pinned one (opened
-- by a build of protocol 15 before this change, on the root agent or an agent it uses as a tool):
-- each is closed (`session_closed`) and its history stays readable. The others carry over.
UPDATE "nylorun"."sessions" SET "body" = ("body"::jsonb || '{"closedReason":"protocol_15"}'::jsonb)::json
WHERE nylorun.doc("body") ->> 'closedReason' IS NULL
  AND (
    jsonb_path_exists(nylorun.doc("body") -> 'manifest', 'lax $.runtime')
    OR jsonb_path_exists(nylorun.doc("body") -> 'manifest', 'lax $.tools[*].agent.runtime')
  );
