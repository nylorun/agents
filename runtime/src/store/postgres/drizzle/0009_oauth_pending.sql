CREATE TABLE "nylorun"."oauth_pending" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"vault_id" text NOT NULL,
	"server" text NOT NULL,
	"url" text NOT NULL,
	"token_endpoint" text NOT NULL,
	"client_id" text NOT NULL,
	"token_endpoint_auth" text NOT NULL,
	"resource" text,
	"kek_id" text NOT NULL,
	"client_secret" "bytea",
	"code_verifier" "bytea" NOT NULL,
	"redirect_uri" text NOT NULL,
	"expires_at" text COLLATE "C" NOT NULL,
	"created_at" text COLLATE "C" NOT NULL
);
--> statement-breakpoint
ALTER TABLE "nylorun"."oauth_pending" ADD CONSTRAINT "oauth_pending_vault_id_fkey" FOREIGN KEY ("vault_id") REFERENCES "nylorun"."vaults"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "oauth_pending_expires" ON "nylorun"."oauth_pending" USING btree ("expires_at");