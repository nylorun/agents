CREATE TABLE "nylorun"."sandbox_signals" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"sandbox_id" text COLLATE "C" NOT NULL,
	"kind" text NOT NULL,
	"timer" text,
	"at" bigint,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"parked_at" timestamp with time zone,
	CONSTRAINT "sandbox_signals_kind_check" CHECK ("nylorun"."sandbox_signals"."kind" IN ('reconcile', 'arm'))
);
--> statement-breakpoint
ALTER TABLE "nylorun"."control_signals" DROP CONSTRAINT "control_signals_kind_check";--> statement-breakpoint
ALTER TABLE "nylorun"."control_signals" ADD COLUMN "sandbox_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."control_signals" ADD COLUMN "epoch" integer;--> statement-breakpoint
CREATE INDEX "sandbox_signals_created_at" ON "nylorun"."sandbox_signals" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "nylorun"."control_signals" ADD CONSTRAINT "control_signals_kind_check" CHECK ("nylorun"."control_signals"."kind" IN ('session.cancel', 'sessions.reset', 'host.revoked'));