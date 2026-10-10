CREATE TABLE "nylorun"."control_signals" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "nylorun"."control_signals_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"session_id" text COLLATE "C",
	"turn_id" text COLLATE "C",
	"generation" integer,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	CONSTRAINT "control_signals_kind_check" CHECK ("nylorun"."control_signals"."kind" IN ('session.cancel', 'sessions.reset'))
);
--> statement-breakpoint
CREATE INDEX "control_signals_created_at" ON "nylorun"."control_signals" USING btree ("created_at");