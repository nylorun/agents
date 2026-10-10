CREATE TABLE "nylorun"."wakes" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"reason" text NOT NULL,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "wakes_created_at" ON "nylorun"."wakes" USING btree ("created_at");