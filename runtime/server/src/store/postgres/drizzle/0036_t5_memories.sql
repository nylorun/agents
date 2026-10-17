CREATE TABLE "nylorun"."memories" (
	"agent_id" text COLLATE "C" NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"content" text NOT NULL,
	"content_sha256" text NOT NULL,
	"bytes" integer NOT NULL,
	"description" text,
	"version" integer NOT NULL,
	"updated_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "memories_pkey" PRIMARY KEY("agent_id","path")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."memory_versions" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"path" text COLLATE "C" NOT NULL,
	"from_path" text COLLATE "C",
	"operation" text NOT NULL,
	"content" text,
	"content_sha256" text,
	"bytes" integer,
	"actor" text NOT NULL,
	"session_id" text COLLATE "C",
	"turn_id" text COLLATE "C",
	"trigger_run_id" text COLLATE "C",
	"created_at" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "memory_versions_agent" ON "nylorun"."memory_versions" USING btree ("agent_id","id");--> statement-breakpoint
CREATE INDEX "memory_versions_path" ON "nylorun"."memory_versions" USING btree ("agent_id","path","id");