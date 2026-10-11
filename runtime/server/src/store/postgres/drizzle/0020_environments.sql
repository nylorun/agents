-- Protocol 11: Environments (R2d), a fresh start (Q2). Sandbox resources and every vault but
-- the host's are dropped, not mapped: which Environment a person's key belongs in is the app's
-- mapping, and each seal binds its vault id. Sessions opened before protocol 11 are closed
-- (Q12): their history stays readable and a new turn is refused (`session_closed`).
CREATE TABLE "nylorun_streams"."environment_events" (
	"environment_id" text COLLATE "C" NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"body" json NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "environment_events_pkey" PRIMARY KEY("environment_id","seq")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."environments" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"labels" json NOT NULL,
	"recipe" json NOT NULL,
	"applied" json NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"applied_version" integer DEFAULT 1 NOT NULL,
	"owner_user_id" text,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	"k8s_name" text COLLATE "C",
	"volume_gen" integer DEFAULT 0 NOT NULL,
	"desired" text,
	"observed" text,
	"pod_uid" text,
	"host_epoch" integer DEFAULT 0 NOT NULL,
	"join_token_hash" text,
	"rev" integer DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"reason" text,
	"retiring" text COLLATE "C",
	"volume_id" text,
	CONSTRAINT "environments_kind_check" CHECK ("nylorun"."environments"."kind" IN ('virtual', 'pod', 'none'))
);
--> statement-breakpoint
DROP TABLE "nylorun_streams"."sandbox_events" CASCADE;--> statement-breakpoint
DROP TABLE "nylorun"."sandbox_resources" CASCADE;--> statement-breakpoint
DELETE FROM "nylorun"."vaults" WHERE "id" <> 'host';--> statement-breakpoint
DELETE FROM "nylorun"."vault_idempotency" WHERE "id" NOT LIKE 'host-model%';--> statement-breakpoint
DELETE FROM "nylorun"."sandboxes";--> statement-breakpoint
DELETE FROM "nylorun"."sandbox_signals";--> statement-breakpoint
UPDATE "nylorun"."sessions" SET "body" = (("body"::jsonb - 'sandboxId' - 'sandboxSource' - 'sandboxOwnerId' - 'sandbox' - 'vaultIds' - 'credentialSelections') || '{"closedReason":"protocol_11"}'::jsonb)::json;--> statement-breakpoint
UPDATE "nylorun"."tenant_settings" SET "key" = 'environments.config', "value" = ((("value"::jsonb - 'default') #- '{limits,ttl}' #- '{lifecycle,onExpiry}' #- '{limits,sandboxes}') || CASE WHEN ("value"::jsonb #> '{limits,sandboxes}') IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('limits', (("value"::jsonb -> 'limits') - 'sandboxes' - 'ttl') || jsonb_build_object('environments', "value"::jsonb #> '{limits,sandboxes}')) END)::text WHERE "key" = 'sandbox.config';--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" DROP CONSTRAINT "vaults_scope_check";--> statement-breakpoint
DROP INDEX "nylorun"."sessions_sandbox";--> statement-breakpoint
DROP INDEX "nylorun"."vaults_owner";--> statement-breakpoint
DROP INDEX "nylorun"."vaults_one_host";--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" ADD COLUMN "environment_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'environmentId') STORED;--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" ADD COLUMN "environment_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" ADD CONSTRAINT "vaults_environment_id_fkey" FOREIGN KEY ("environment_id") REFERENCES "nylorun"."environments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_environment" ON "nylorun"."sessions" USING btree ("environment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "vault_credentials_name" ON "nylorun"."vault_credentials" USING btree ("vault_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "vaults_environment" ON "nylorun"."vaults" USING btree ("environment_id");--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" DROP COLUMN "sandbox_id";--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" DROP COLUMN "owner_user_id";--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" DROP COLUMN "scope";--> statement-breakpoint
ALTER TABLE "nylorun"."vaults" ADD CONSTRAINT "vaults_owner_check" CHECK (("nylorun"."vaults"."id" = 'host') = ("nylorun"."vaults"."environment_id" IS NULL));