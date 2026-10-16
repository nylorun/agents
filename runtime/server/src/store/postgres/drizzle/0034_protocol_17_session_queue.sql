CREATE TABLE "nylorun"."session_queue" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"seq" bigint NOT NULL,
	"command" json NOT NULL,
	"input" json NOT NULL,
	"file_artifacts" json NOT NULL,
	"writer" json NOT NULL,
	"trace" json,
	"created_at" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "session_queue_order" ON "nylorun"."session_queue" USING btree ("session_id","seq");