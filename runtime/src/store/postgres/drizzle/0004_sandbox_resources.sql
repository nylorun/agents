CREATE TABLE "nylorun_streams"."sandbox_events" (
	"sandbox_id" text COLLATE "C" NOT NULL,
	"seq" bigint NOT NULL,
	"type" text NOT NULL,
	"body" json NOT NULL,
	"committed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sandbox_events_pkey" PRIMARY KEY("sandbox_id","seq")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."sandbox_resources" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"spec" json NOT NULL,
	"labels" json NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nylorun"."sessions" ADD COLUMN "sandbox_id" text GENERATED ALWAYS AS (nylorun.doc(body)->>'sandboxId') STORED;--> statement-breakpoint
CREATE INDEX "sessions_sandbox" ON "nylorun"."sessions" USING btree ("sandbox_id");