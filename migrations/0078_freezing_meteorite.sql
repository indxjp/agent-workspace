CREATE TABLE "storage_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"url" text NOT NULL,
	"allowed_prefixes" text[] NOT NULL,
	"write_allowed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "storage_connections_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "storage_connections_provider_valid" CHECK ("storage_connections"."provider" in ('s3', 'gcs', 'azblob', 'file'))
);
--> statement-breakpoint
-- safe: re-added at the end of this file, widened with the seven storage actions; no row is narrowed
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_valid";--> statement-breakpoint
ALTER TABLE "storage_connections" ADD CONSTRAINT "storage_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "storage_connections_workspace_name_key" ON "storage_connections" USING btree ("workspace_id","name");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'project-archived', 'project-restored', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed', 'invitation-created', 'invitation-resent', 'invitation-revoked', 'invitation-accepted', 'endpoint-client-created', 'endpoint-client-changed', 'endpoint-client-revoked', 'endpoint-tool-called', 'oauth-client-secret-rotated', 'oauth-grant-issued', 'oauth-grant-revoked', 'file-uploaded', 'file-downloaded', 'file-link-created', 'file-moved', 'file-deleted', 'storage-connection-created', 'storage-connection-updated', 'storage-connection-deleted', 'storage-connection-credential-changed', 'storage-connection-tested', 'storage-connection-written', 'storage-grant-changed'));