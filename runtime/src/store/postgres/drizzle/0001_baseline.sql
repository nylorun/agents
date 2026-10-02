CREATE TABLE "nylorun"."actions" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL,
	"session_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'sessionId') STORED,
	"turn_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'turnId') STORED,
	"agent_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'agentId') STORED,
	"status" text GENERATED ALWAYS AS (nylorun.doc(body)->>'status') STORED,
	"kind" text GENERATED ALWAYS AS (nylorun.doc(body)->>'kind') STORED,
	"deadline_at" text GENERATED ALWAYS AS (nylorun.doc(body)->>'deadlineAt') STORED
);
--> statement-breakpoint
CREATE TABLE "nylorun"."commands" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."definitions" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."effects" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL,
	"session_id" text GENERATED ALWAYS AS (nylorun.doc(body)->'request'->>'sessionId') STORED,
	"turn_id" text GENERATED ALWAYS AS (nylorun.doc(body)->'request'->>'turnId') STORED,
	"kind" text GENERATED ALWAYS AS (nylorun.doc(body)->'request'->>'kind') STORED,
	"status" text GENERATED ALWAYS AS (nylorun.doc(body)->>'status') STORED
);
--> statement-breakpoint
CREATE TABLE "nylorun"."endpoints" (
	"agent_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"implementation_version" text NOT NULL,
	"manifest_hash" text,
	"timeout_ms" integer NOT NULL,
	"max_concurrent" integer NOT NULL,
	"principal_id" text,
	"last_delivery_at" text,
	"last_success_at" text,
	"last_error_code" text,
	"last_error_message" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"served_implementation_version" text,
	"served_manifest_hash" text,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."links" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL,
	"workflow_session_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'workflowSessionId') STORED
);
--> statement-breakpoint
CREATE TABLE "nylorun"."model_budgets" (
	"scope" text NOT NULL,
	"scope_id" text COLLATE "C" NOT NULL,
	"period" text,
	"limit_usd" double precision,
	"limit_tokens" bigint,
	"updated_at" text NOT NULL,
	CONSTRAINT "model_budgets_pkey" PRIMARY KEY("scope","scope_id")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."model_usage" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"effect_key" text COLLATE "C" NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"turn_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"total_tokens" integer NOT NULL,
	"cached_tokens" integer NOT NULL,
	"cache_write_tokens" integer NOT NULL,
	"reasoning_tokens" integer NOT NULL,
	"cost_usd" double precision NOT NULL,
	"duplicate" boolean NOT NULL,
	"created_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."principals" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"idempotency_key" text,
	"created_at" text NOT NULL,
	CONSTRAINT "principals_token_hash_key" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."publishable_keys" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"key" text COLLATE "C" NOT NULL,
	"name" text NOT NULL,
	"origins_json" text NOT NULL,
	"created_at" text NOT NULL,
	"revoked_at" text,
	CONSTRAINT "publishable_keys_key_key" UNIQUE("key"),
	CONSTRAINT "publishable_keys_name_key" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "nylorun_streams"."relay_slots" (
	"slot_name" text PRIMARY KEY NOT NULL,
	"reconcile_pending" boolean NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."sandboxes" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun_streams"."session_events" (
	"session_id" text COLLATE "C" NOT NULL,
	"seq" bigint NOT NULL,
	"generation" integer NOT NULL,
	"type" text NOT NULL,
	"body" json NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_events_pkey" PRIMARY KEY("session_id","seq")
);
--> statement-breakpoint
CREATE TABLE "nylorun_streams"."session_log_heads" (
	"session_id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"generation" integer NOT NULL,
	"head" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."sessions" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"body" json NOT NULL,
	"status" text GENERATED ALWAYS AS (nylorun.doc(body)->>'status') STORED,
	"agent_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'agentId') STORED,
	"owner" text,
	"epoch" bigint DEFAULT 0 NOT NULL,
	"owner_expires_at" timestamp with time zone,
	"owner_user_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'ownerUserId') STORED
);
--> statement-breakpoint
CREATE TABLE "nylorun"."signing_keys" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"alg" text NOT NULL,
	"public_jwk" text NOT NULL,
	"kek_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL,
	"created_at" text NOT NULL,
	"activated_at" text,
	"retired_at" text,
	"revoked_at" text,
	CONSTRAINT "signing_keys_state_check" CHECK (state IN ('standby', 'current', 'previous', 'revoked')),
	CONSTRAINT "signing_keys_alg_check" CHECK (alg = 'ES256')
);
--> statement-breakpoint
CREATE TABLE "nylorun"."subject_epochs" (
	"subject" text COLLATE "C" PRIMARY KEY NOT NULL,
	"epoch" bigint NOT NULL,
	"revoked_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."subject_usage" (
	"subject" text COLLATE "C" PRIMARY KEY NOT NULL,
	"turn_tokens" double precision NOT NULL,
	"refilled_at" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."tenant" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"created_at" text NOT NULL,
	"updated_at" text NOT NULL,
	"schema_version" integer NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"basin_generation" integer DEFAULT 0 NOT NULL,
	"retired_generations" integer[] DEFAULT '{}' NOT NULL,
	CONSTRAINT "tenant_singleton_key" UNIQUE("singleton"),
	CONSTRAINT "tenant_singleton_check" CHECK (singleton)
);
--> statement-breakpoint
CREATE TABLE "nylorun"."tenant_settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."vault_audit" (
	"ord" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nylorun"."vault_audit_ord_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"id" text NOT NULL,
	"at" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"vault_id" text,
	"credential_id" text,
	"session_id" text,
	"target" text,
	"outcome" text NOT NULL,
	CONSTRAINT "vault_audit_id_key" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."vault_credentials" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"binding_json" text NOT NULL,
	"expires_at" text,
	"created_at" text COLLATE "C" NOT NULL,
	"rotated_at" text,
	"kek_id" text NOT NULL,
	"nonce" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"wrapped_dek" "bytea" NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."vault_idempotency" (
	"id" text PRIMARY KEY NOT NULL,
	"body_hash" text NOT NULL,
	"response" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "nylorun"."vaults" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"owner_user_id" text NOT NULL,
	"metadata_json" text,
	"created_at" text COLLATE "C" NOT NULL,
	"scope" text DEFAULT 'user' NOT NULL,
	CONSTRAINT "vaults_scope_check" CHECK (scope IN ('user', 'host'))
);
--> statement-breakpoint
ALTER TABLE "nylorun"."vault_credentials" ADD CONSTRAINT "vault_credentials_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "nylorun"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "actions_session" ON "nylorun"."actions" USING btree ("session_id","turn_id","status");--> statement-breakpoint
CREATE INDEX "actions_agent" ON "nylorun"."actions" USING btree ("agent_id","status");--> statement-breakpoint
CREATE INDEX "actions_status" ON "nylorun"."actions" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "actions_deadline" ON "nylorun"."actions" USING btree ("status","deadline_at");--> statement-breakpoint
CREATE INDEX "effects_session" ON "nylorun"."effects" USING btree ("session_id","turn_id","status");--> statement-breakpoint
CREATE INDEX "effects_status" ON "nylorun"."effects" USING btree ("status","kind");--> statement-breakpoint
CREATE INDEX "links_workflow" ON "nylorun"."links" USING btree ("workflow_session_id");--> statement-breakpoint
CREATE INDEX "model_usage_effect" ON "nylorun"."model_usage" USING btree ("effect_key");--> statement-breakpoint
CREATE INDEX "model_usage_agent" ON "nylorun"."model_usage" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "model_usage_turn" ON "nylorun"."model_usage" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "model_usage_created" ON "nylorun"."model_usage" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_status" ON "nylorun"."sessions" USING btree ("status","owner_expires_at");--> statement-breakpoint
CREATE INDEX "sessions_agent" ON "nylorun"."sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_user" ON "nylorun"."sessions" USING btree ("owner_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_standby" ON "nylorun"."signing_keys" USING btree ("state") WHERE state = 'standby';--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_current" ON "nylorun"."signing_keys" USING btree ("state") WHERE state = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_previous" ON "nylorun"."signing_keys" USING btree ("state") WHERE state = 'previous';--> statement-breakpoint
CREATE INDEX "vault_audit_vault" ON "nylorun"."vault_audit" USING btree ("vault_id","ord");--> statement-breakpoint
CREATE INDEX "vault_credentials_vault" ON "nylorun"."vault_credentials" USING btree ("vault_id","created_at","id");--> statement-breakpoint
CREATE INDEX "vaults_owner" ON "nylorun"."vaults" USING btree ("owner_user_id","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "vaults_one_host" ON "nylorun"."vaults" USING btree ("scope") WHERE scope = 'host';