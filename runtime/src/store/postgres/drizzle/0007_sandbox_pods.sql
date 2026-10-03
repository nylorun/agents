ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "k8s_name" text COLLATE "C";--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "volume_gen" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "desired" text;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "observed" text;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "pod_uid" text;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "host_epoch" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "join_token_hash" text;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "rev" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "last_active_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "nylorun"."sandbox_resources" ADD COLUMN "retiring" text COLLATE "C";