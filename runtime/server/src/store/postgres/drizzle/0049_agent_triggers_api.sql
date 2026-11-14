ALTER TABLE "nylorun"."agent_triggers" DROP CONSTRAINT "agent_triggers_origin_check";--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD COLUMN "principal" text;--> statement-breakpoint
ALTER TABLE "nylorun"."agent_triggers" ADD CONSTRAINT "agent_triggers_origin_check" CHECK ("nylorun"."agent_triggers"."origin" IN ('manifest', 'agent', 'api', 'wake'));