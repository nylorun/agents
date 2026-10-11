-- R7.1: the gate's own timing of a model call (its span): when it sent the call, when the answer
-- was complete, and how long the provider took to its first stream event. Null on older rows.
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "started_at" text;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "ended_at" text;--> statement-breakpoint
ALTER TABLE "nylorun"."model_usage" ADD COLUMN "first_token_ms" integer;