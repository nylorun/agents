-- Custom SQL (a data change): the origin of the trigger rows and runs written before 0043 (D83). A
-- booked wake's is `wake`; every other came from its manifest (`manifest`, the columns' default).
-- Runs recorded before the Tenant runs stream are marked streamed, so the sweep does not append
-- the history of the last 30 days to the new `runs` stream: it starts with the runs made from here
-- on.
UPDATE "nylorun"."agent_triggers" SET "origin" = 'wake' WHERE "kind" = 'wake';--> statement-breakpoint
UPDATE "nylorun"."trigger_runs" SET "origin" = 'wake' WHERE "kind" = 'wake';--> statement-breakpoint
UPDATE "nylorun"."trigger_runs" SET "streamed_at" = "fired_at" WHERE "streamed_at" IS NULL;
