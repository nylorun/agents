ALTER TABLE "nylorun"."wakes" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."wakes" ADD COLUMN "retry_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nylorun"."wakes" ADD COLUMN "parked_at" timestamp with time zone;