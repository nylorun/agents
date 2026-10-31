CREATE TABLE "nylorun"."a2a_push_configs" (
	"session_id" text COLLATE "C" NOT NULL,
	"task_id" text COLLATE "C" NOT NULL,
	"config_id" text COLLATE "C" NOT NULL,
	"context_id" text NOT NULL,
	"turn_id" text COLLATE "C" NOT NULL,
	"url" text NOT NULL,
	"token" text,
	"authentication" json,
	"base_url" text NOT NULL,
	"extensions" json NOT NULL,
	"trace_id" text,
	"next_seq" bigint NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"done_at" timestamp with time zone,
	CONSTRAINT "a2a_push_configs_pkey" PRIMARY KEY("session_id","task_id","config_id")
);
--> statement-breakpoint
CREATE TABLE "nylorun"."a2a_pushes" (
	"id" text COLLATE "C" PRIMARY KEY NOT NULL,
	"session_id" text COLLATE "C" NOT NULL,
	"task_id" text COLLATE "C" NOT NULL,
	"config_id" text COLLATE "C" NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"retry_at" timestamp with time zone,
	"parked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "a2a_push_configs_done_at" ON "nylorun"."a2a_push_configs" USING btree ("done_at");--> statement-breakpoint
CREATE INDEX "a2a_pushes_created_at" ON "nylorun"."a2a_pushes" USING btree ("created_at");