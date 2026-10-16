CREATE TABLE "nylorun"."agent_triggers" (
	"agent_id" text COLLATE "C" NOT NULL,
	"trigger_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"paused_reason" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"next_fire_at" text COLLATE "C",
	"last_fire_at" text COLLATE "C",
	"endpoint_id" text COLLATE "C",
	"sealed_secret" json,
	"session_id" text COLLATE "C",
	"note" text,
	"effect_id" text,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "agent_triggers_pkey" PRIMARY KEY("agent_id","trigger_id")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."trigger_runs" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"trigger_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"run_key" text COLLATE "C" NOT NULL,
	"due_at" text COLLATE "C" NOT NULL,
	"fired_at" text COLLATE "C" NOT NULL,
	"late" boolean DEFAULT false NOT NULL,
	"status" text NOT NULL,
	"reason" text,
	"session_id" text COLLATE "C",
	"turn_id" text COLLATE "C",
	"queued_message_id" text COLLATE "C"
);
--> statement-breakpoint
ALTER TABLE "nylorun"."session_queue" ADD COLUMN "cause" json;--> statement-breakpoint
CREATE INDEX "agent_triggers_due" ON "nylorun"."agent_triggers" USING btree ("status","next_fire_at");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_triggers_endpoint" ON "nylorun"."agent_triggers" USING btree ("endpoint_id") WHERE endpoint_id IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_runs_key" ON "nylorun"."trigger_runs" USING btree ("agent_id","run_key");--> statement-breakpoint
CREATE INDEX "trigger_runs_agent" ON "nylorun"."trigger_runs" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "trigger_runs_fired" ON "nylorun"."trigger_runs" USING btree ("fired_at");