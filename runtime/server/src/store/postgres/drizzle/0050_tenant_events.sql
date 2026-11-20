-- ADR-159: the Tenant's stream, which gives keys, signing keys, tool policy, settings, vault
-- credentials written and used, and Studio sign-ins a history (`GET /v1/tenant/audit`). Written
-- only by the record module; not in the stream relay's publication.
CREATE TABLE "nylorun_streams"."tenant_events" (
	"seq" bigint PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"source" text NOT NULL,
	"principal" text NOT NULL,
	"payload" json NOT NULL
);
--> statement-breakpoint
CREATE INDEX "tenant_events_at" ON "nylorun_streams"."tenant_events" USING btree ("at");