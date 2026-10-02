CREATE TABLE "nylorun"."tool_crossings" (
	"key" text COLLATE "C" PRIMARY KEY NOT NULL,
	"hash" text NOT NULL,
	"started_at" text COLLATE "C" NOT NULL,
	"settled_at" text COLLATE "C",
	"answer" json
);
--> statement-breakpoint
CREATE INDEX "tool_crossings_settled" ON "nylorun"."tool_crossings" USING btree ("settled_at");