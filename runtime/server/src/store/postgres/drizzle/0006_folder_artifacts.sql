CREATE TABLE "nylorun"."artifact_content" (
	"artifact_id" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"sha256" text COLLATE "C" NOT NULL,
	"size" bigint NOT NULL,
	CONSTRAINT "artifact_content_pkey" PRIMARY KEY("artifact_id","version","sha256")
);
--> statement-breakpoint
ALTER TABLE "nylorun"."artifacts" DROP CONSTRAINT "artifacts_kind_check";--> statement-breakpoint
ALTER TABLE "nylorun"."artifact_content" ADD CONSTRAINT "artifact_content_version_fkey" FOREIGN KEY ("artifact_id","version") REFERENCES "nylorun"."artifact_versions"("artifact_id","version") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_content_sha256" ON "nylorun"."artifact_content" USING btree ("sha256");--> statement-breakpoint
ALTER TABLE "nylorun"."artifacts" ADD CONSTRAINT "artifacts_kind_check" CHECK (kind IN ('file', 'folder'));