-- Protocol 15: the harness boundary. `read_artifact` and `save_artifact` are our harness's own
-- tools, no longer the Runtime's: the manifest schema refuses a pinned `runtime` block that holds
-- them. A fresh start for the sessions that pinned one (every agent session since protocol 12):
-- each is closed (`session_closed`) and its history stays readable. Workflow sessions pin no
-- `runtime` block and carry over.
UPDATE "nylorun"."sessions" SET "body" = ("body"::jsonb || '{"closedReason":"protocol_15"}'::jsonb)::json
WHERE nylorun.doc("body") ->> 'closedReason' IS NULL
  AND jsonb_path_exists(
    nylorun.doc("body") -> 'manifest' -> 'runtime' -> 'tools',
    '$[*] ? (@.name == "read_artifact" || @.name == "save_artifact")'
  );
