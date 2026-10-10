CREATE TABLE "nylorun"."definition_file_uses" (
	"agent_id" text COLLATE "C" NOT NULL,
	"manifest_hash" text COLLATE "C" NOT NULL,
	"sha256" text COLLATE "C" NOT NULL,
	CONSTRAINT "definition_file_uses_pkey" PRIMARY KEY("agent_id","manifest_hash","sha256")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."definition_files" (
	"sha256" text COLLATE "C" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"size" bigint NOT NULL,
	"content_type" text,
	"created_at" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
CREATE INDEX "definition_file_uses_sha256" ON "nylorun"."definition_file_uses" USING btree ("sha256");