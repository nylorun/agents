CREATE TABLE "nylorun"."environment_manifests" (
	"name" text COLLATE "C" NOT NULL,
	"version" integer NOT NULL,
	"body" json NOT NULL,
	"hash" text COLLATE "C" NOT NULL,
	"saved_by" json NOT NULL,
	"created_at" text COLLATE "C" NOT NULL,
	CONSTRAINT "environment_manifests_pkey" PRIMARY KEY("name","version")
);
--> statement-breakpoint
ALTER TABLE "nylorun"."environments" ADD COLUMN "manifest_name" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."environments" ADD COLUMN "manifest_version" integer;--> statement-breakpoint
ALTER TABLE "nylorun"."environments" ADD COLUMN "manifest_hash" text COLLATE "C";--> statement-breakpoint
CREATE INDEX "environments_manifest" ON "nylorun"."environments" USING btree ("manifest_name","manifest_version");