ALTER TABLE "nylorun"."model_usage" ADD COLUMN "cost_input_usd" double precision;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "cost_cache_read_usd" double precision;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "cost_cache_write_usd" double precision;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "cost_output_usd" double precision;