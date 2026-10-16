-- Protocol 16: Agents from one manifest (track T2), a fresh start. Agent definitions and
-- environment manifests cannot become agent manifests (v8) on their own: a definition has no
-- runtime section, and an Environment held sessions of many agents. So both go, and so do the
-- Environments with their pods, disks and vaults, as protocol 11 dropped sandboxes and vaults.
-- Every open session is closed (`protocol_16`): its history stays readable. `environments` is
-- renamed `agents` (made from a saved agent manifest only) and its lifecycle stream
-- `agent_events`; model budget scope `agent` is `manifest`, keyed by the manifest's name, so a
-- budget keeps its meaning, and the usage ledger names the manifest.
UPDATE "nylorun"."sessions" SET "body" = ("body"::jsonb || '{"closedReason":"protocol_16"}'::jsonb)::json
WHERE nylorun.doc("body") ->> 'closedReason' IS NULL;--> statement-breakpoint
DELETE FROM "nylorun"."vaults" WHERE "id" <> 'host';--> statement-breakpoint
DELETE FROM "nylorun"."vault_idempotency" WHERE "id" NOT LIKE 'host-model%';--> statement-breakpoint
DELETE FROM "nylorun"."sandboxes";--> statement-breakpoint
DELETE FROM "nylorun"."sandbox_signals";--> statement-breakpoint
DELETE FROM "nylorun"."artifacts" WHERE "environment_id" IS NOT NULL;--> statement-breakpoint
DELETE FROM "nylorun"."environments";--> statement-breakpoint
DELETE FROM "nylorun"."definition_file_uses";--> statement-breakpoint
DROP TABLE "nylorun"."definitions";--> statement-breakpoint
DROP TABLE "nylorun"."environment_manifests";--> statement-breakpoint
DROP TABLE "nylorun_streams"."environment_events";--> statement-breakpoint
CREATE TABLE "nylorun_streams"."agent_events" (
	"agent_id" text COLLATE "C" NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"body" json NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_events_pkey" PRIMARY KEY("agent_id","seq")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."agent_manifests" (
	"name" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"body" json NOT NULL,
	"hash" text COLLATE "C" NOT NULL,
	"saved_by" json NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "agent_manifests_pkey" PRIMARY KEY("name","version")
);
--> statement-breakpoint
ALTER TABLE "nylorun"."environments" RENAME TO "agents";--> statement-breakpoint
ALTER TABLE "nylorun"."agents" RENAME CONSTRAINT "environments_pkey" TO "agents_pkey";--> statement-breakpoint
ALTER TABLE "nylorun"."agents" DROP CONSTRAINT "environments_kind_check";--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ADD CONSTRAINT "agents_kind_check" CHECK ("nylorun"."agents"."kind" IN ('virtual', 'pod', 'none'));--> statement-breakpoint
ALTER INDEX "nylorun"."environments_manifest" RENAME TO "agents_manifest";--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ALTER COLUMN "manifest_name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ALTER COLUMN "manifest_version" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ALTER COLUMN "manifest_hash" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ADD COLUMN "manifest_ref" text NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ADD COLUMN "desired_state" text DEFAULT 'on' NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" RENAME COLUMN "agent_id" TO "manifest_name";--> statement-breakpoint
ALTER INDEX "nylorun"."model_usage_agent" RENAME TO "model_usage_manifest";--> statement-breakpoint
UPDATE "nylorun"."model_budgets" SET "scope" = 'manifest' WHERE "scope" = 'agent';--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" ADD COLUMN "manifest_name" text GENERATED ALWAYS AS (nylorun.doc(body)->'definition'->>'name') STORED;--> statement-breakpoint
CREATE INDEX "sessions_manifest" ON "nylorun"."sessions" USING btree ("manifest_name");
