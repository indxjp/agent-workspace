CREATE TABLE "workspace_features" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"feature" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_features_workspace_feature_key" UNIQUE("workspace_id","feature"),
	CONSTRAINT "workspace_features_feature_valid" CHECK ("workspace_features"."feature" in ('chat', 'projects', 'files', 'skills', 'connectors', 'runs', 'sharing', 'surfaces', 'triggers', 'evaluations', 'builder'))
);
--> statement-breakpoint
-- safe: widens the CHECK to a superset; no row can violate it
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_valid";--> statement-breakpoint
ALTER TABLE "workspace_features" ADD CONSTRAINT "workspace_features_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'agent-created', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'project-archived', 'project-restored', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed', 'invitation-created', 'invitation-resent', 'invitation-revoked', 'invitation-accepted', 'endpoint-client-created', 'endpoint-client-changed', 'endpoint-client-revoked', 'endpoint-tool-called', 'oauth-client-secret-rotated', 'oauth-grant-issued', 'oauth-grant-revoked', 'file-uploaded', 'file-downloaded', 'file-link-created', 'file-moved', 'file-deleted', 'storage-connection-created', 'storage-connection-updated', 'storage-connection-deleted', 'storage-connection-credential-changed', 'storage-connection-tested', 'storage-connection-written', 'storage-grant-changed', 'workspace-features-changed'));