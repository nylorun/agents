DROP TABLE "nylorun"."oauth_pending" CASCADE;--> statement-breakpoint
INSERT INTO "nylorun"."vault_audit" ("id", "at", "actor", "action", "vault_id", "credential_id", "target", "outcome")
SELECT gen_random_uuid()::text, to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'migration', 'delete', "vault_id", "id", "binding_json"::jsonb ->> 'url', 'deleted'
FROM "nylorun"."vault_credentials" WHERE "type" = 'oauth' ORDER BY "vault_id", "id";--> statement-breakpoint
DELETE FROM "nylorun"."vault_credentials" WHERE "type" = 'oauth';
