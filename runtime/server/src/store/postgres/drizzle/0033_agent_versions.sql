-- Track T3, Agents that evolve (D73): an Agent moves between versions of its manifest. While it
-- is outdated it names the version it moves to (`target_version`); a version that failed to start
-- is kept so a tracking Agent does not move to it again (`failed_version`); and while a pod starts
-- on a new version, what it ran before (`start_check`), which a failed start reverts to.
ALTER TABLE "nylorun"."agents" ADD COLUMN "target_version" integer;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ADD COLUMN "failed_version" integer;--> statement-breakpoint
ALTER TABLE "nylorun"."agents" ADD COLUMN "start_check" json;