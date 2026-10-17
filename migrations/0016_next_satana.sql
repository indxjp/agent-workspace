CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invitations_role_valid" CHECK ("invitations"."role" in ('owner', 'admin', 'builder', 'viewer')),
	CONSTRAINT "invitations_email_lowercase" CHECK ("invitations"."email" = lower("invitations"."email")),
	CONSTRAINT "invitations_email_shape" CHECK ("invitations"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	CONSTRAINT "invitations_token_hash_not_blank" CHECK (length(btrim("invitations"."token_hash")) > 0),
	CONSTRAINT "invitations_expires_after_created" CHECK ("invitations"."expires_at" > "invitations"."created_at"),
	CONSTRAINT "invitations_accepted_after_created" CHECK ("invitations"."accepted_at" is null or "invitations"."accepted_at" >= "invitations"."created_at"),
	CONSTRAINT "invitations_revoked_after_created" CHECK ("invitations"."revoked_at" is null or "invitations"."revoked_at" >= "invitations"."created_at"),
	CONSTRAINT "invitations_not_accepted_and_revoked" CHECK ("invitations"."accepted_at" is null or "invitations"."revoked_at" is null)
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_valid";--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_workspace_email_pending_key" ON "invitations" USING btree ("workspace_id","email") WHERE "invitations"."accepted_at" is null and "invitations"."revoked_at" is null;--> statement-breakpoint
CREATE INDEX "invitations_workspace_idx" ON "invitations" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "invitations_invited_by_idx" ON "invitations" USING btree ("invited_by");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed', 'invitation-created', 'invitation-resent', 'invitation-revoked', 'invitation-accepted'));
