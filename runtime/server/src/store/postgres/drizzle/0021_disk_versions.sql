-- R2d step 3: an Environment's disk versions are one folder artifact it owns (environment_id),
-- and its row holds the disk lease (disk_op) and the version its next volume starts from
-- (disk_seed).
ALTER TABLE "nylorun"."artifacts" ADD COLUMN "environment_id" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."environments" ADD COLUMN "disk_op" json;--> statement-breakpoint
ALTER TABLE "nylorun"."environments" ADD COLUMN "disk_seed" json;--> statement-breakpoint
CREATE UNIQUE INDEX "artifacts_environment_disk" ON "nylorun"."artifacts" USING btree ("environment_id") WHERE environment_id IS NOT NULL;