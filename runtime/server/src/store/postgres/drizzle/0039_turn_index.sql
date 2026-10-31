CREATE TABLE "nylorun"."turns" (
	"session_id" text COLLATE "C" NOT NULL,
	"turn_id" text COLLATE "C" NOT NULL,
	"agent_id" text COLLATE "C" NOT NULL,
	"owner_user_id" text COLLATE "C",
	"a2a_context_id" text COLLATE "C",
	"status" text NOT NULL,
	"started_at" text COLLATE "C" NOT NULL,
	"ended_at" text COLLATE "C",
	"changed_at" text COLLATE "C" NOT NULL,
	"totals" json,
	"first_seq" bigint NOT NULL,
	"last_seq" bigint NOT NULL,
	"txid" "xid8" DEFAULT pg_current_xact_id() NOT NULL,
	CONSTRAINT "turns_pkey" PRIMARY KEY("session_id","turn_id")
);
--> statement-breakpoint
CREATE INDEX "turns_turn" ON "nylorun"."turns" USING btree ("turn_id");--> statement-breakpoint
CREATE INDEX "turns_changes" ON "nylorun"."turns" USING btree ("txid","session_id","turn_id");--> statement-breakpoint
CREATE INDEX "turns_owner_changes" ON "nylorun"."turns" USING btree ("owner_user_id","txid");--> statement-breakpoint
CREATE INDEX "turns_owner_agent" ON "nylorun"."turns" USING btree ("owner_user_id","agent_id","changed_at");