ALTER TABLE "nylorun"."model_usage" ADD COLUMN "tokens_reported" boolean;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "cost_known" boolean;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" ADD COLUMN "created_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" ALTER COLUMN "created_at" SET DEFAULT now();--> statement-breakpoint
CREATE INDEX "model_usage_session" ON "nylorun"."model_usage" USING btree ("session_id","created_at","id");--> statement-breakpoint
CREATE INDEX "model_usage_export" ON "nylorun"."model_usage" USING btree ("txid","id");--> statement-breakpoint
CREATE INDEX "sessions_created" ON "nylorun"."sessions" USING btree ("created_at" DESC NULLS LAST,"id" DESC NULLS FIRST);