CREATE TABLE "nylorun"."artifact_versions" (
	"artifact_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"blob_key" text NOT NULL,
	"size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"content_type" text NOT NULL,
	"source" text NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "artifact_versions_pkey" PRIMARY KEY("artifact_id","version")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."artifacts" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"content_type" text NOT NULL,
	"session_id" text COLLATE "C",
	"latest_version" integer NOT NULL,
	"labels_json" text,
	"created_at" text COLLATE "C" NOT NULL,
	"updated_at" text NOT NULL,
	CONSTRAINT "artifacts_kind_check" CHECK (kind = 'file')
);
--> statement-breakpoint
ALTER TABLE "nylorun"."artifact_versions" ADD CONSTRAINT "artifact_versions_artifact_id_fkey" FOREIGN KEY ("artifact_id") REFERENCES "nylorun"."artifacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifacts_session" ON "nylorun"."artifacts" USING btree ("session_id","created_at","id");