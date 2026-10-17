CREATE TABLE "oauth_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"client_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"token_hash" text NOT NULL,
	"subject_principal_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"family_id" uuid NOT NULL,
	"code_challenge" text,
	"redirect_uri" text,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oauth_tokens_kind_valid" CHECK ("oauth_tokens"."kind" in ('code', 'access', 'refresh')),
	CONSTRAINT "oauth_tokens_code_fields" CHECK (("oauth_tokens"."kind" = 'code') = ("oauth_tokens"."code_challenge" is not null and "oauth_tokens"."redirect_uri" is not null)),
	CONSTRAINT "oauth_tokens_expiry_after_created" CHECK ("oauth_tokens"."expires_at" > "oauth_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_valid";--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD COLUMN "client_secret_hash" text;--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD COLUMN "redirect_uris" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD COLUMN "client_secret_rotated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_client_workspace_fk" FOREIGN KEY ("workspace_id","client_id") REFERENCES "public"."endpoint_clients"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "oauth_tokens" ADD CONSTRAINT "oauth_tokens_subject_workspace_fk" FOREIGN KEY ("workspace_id","subject_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "oauth_tokens_hash_key" ON "oauth_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "oauth_tokens_workspace_family_idx" ON "oauth_tokens" USING btree ("workspace_id","family_id");--> statement-breakpoint
CREATE INDEX "oauth_tokens_workspace_client_idx" ON "oauth_tokens" USING btree ("workspace_id","client_id","revoked_at");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'project-archived', 'project-restored', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed', 'invitation-created', 'invitation-resent', 'invitation-revoked', 'invitation-accepted', 'endpoint-client-created', 'endpoint-client-changed', 'endpoint-client-revoked', 'endpoint-tool-called', 'oauth-client-secret-rotated', 'oauth-grant-issued', 'oauth-grant-revoked'));--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD CONSTRAINT "endpoint_clients_redirect_uris_max" CHECK (cardinality("endpoint_clients"."redirect_uris") <= 10);