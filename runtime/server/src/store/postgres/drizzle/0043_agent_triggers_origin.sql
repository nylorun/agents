ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "origin" text DEFAULT 'manifest' NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "definition" json;--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "created_session_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "created_turn_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."trigger_runs" ADD COLUMN "origin" text DEFAULT 'manifest' NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."trigger_runs" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "nylorun"."trigger_runs" ADD COLUMN "streamed_at" text COLLATE "C";--> statement-breakpoint
CREATE INDEX "agent_triggers_created_session" ON "nylorun"."agent_triggers" USING btree ("agent_id","created_session_id") WHERE created_session_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX "trigger_runs_unstreamed" ON "nylorun"."trigger_runs" USING btree ("fired_at") WHERE streamed_at IS NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD CONSTRAINT "agent_triggers_origin_check" CHECK ("nylorun"."agent_triggers"."origin" IN ('manifest', 'agent', 'wake'));