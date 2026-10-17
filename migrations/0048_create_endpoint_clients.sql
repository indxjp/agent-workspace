CREATE TABLE "endpoint_client_agents" (
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	CONSTRAINT "endpoint_client_agents_client_id_agent_id_pk" PRIMARY KEY("client_id","agent_id")
);
--> statement-breakpoint
CREATE TABLE "endpoint_client_api_keys" (
	"api_key_id" uuid PRIMARY KEY NOT NULL,
	"client_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "endpoint_clients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"tool_names" text[],
	"acts_for_principal_id" uuid NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "endpoint_clients_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "endpoint_clients_kind_valid" CHECK ("endpoint_clients"."kind" in ('mcp-project', 'a2a-agent')),
	CONSTRAINT "endpoint_clients_tool_names_mcp_only" CHECK ("endpoint_clients"."tool_names" is null or "endpoint_clients"."kind" = 'mcp-project'),
	CONSTRAINT "endpoint_clients_revoked_after_created" CHECK ("endpoint_clients"."revoked_at" is null or "endpoint_clients"."revoked_at" >= "endpoint_clients"."created_at")
);
--> statement-breakpoint
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_action_valid";--> statement-breakpoint
ALTER TABLE "endpoint_client_agents" ADD CONSTRAINT "endpoint_client_agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_client_agents" ADD CONSTRAINT "endpoint_client_agents_client_workspace_fk" FOREIGN KEY ("workspace_id","client_id") REFERENCES "public"."endpoint_clients"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_client_agents" ADD CONSTRAINT "endpoint_client_agents_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_client_api_keys" ADD CONSTRAINT "endpoint_client_api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_client_api_keys" ADD CONSTRAINT "endpoint_client_api_keys_client_workspace_fk" FOREIGN KEY ("workspace_id","client_id") REFERENCES "public"."endpoint_clients"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_client_api_keys" ADD CONSTRAINT "endpoint_client_api_keys_api_key_workspace_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."api_keys"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD CONSTRAINT "endpoint_clients_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD CONSTRAINT "endpoint_clients_acts_for_workspace_fk" FOREIGN KEY ("workspace_id","acts_for_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD CONSTRAINT "endpoint_clients_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "endpoint_client_agents_workspace_idx" ON "endpoint_client_agents" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "endpoint_client_api_keys_workspace_client_idx" ON "endpoint_client_api_keys" USING btree ("workspace_id","client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "endpoint_clients_workspace_kind_name_key" ON "endpoint_clients" USING btree ("workspace_id","kind","name");--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'project-archived', 'project-restored', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed', 'invitation-created', 'invitation-resent', 'invitation-revoked', 'invitation-accepted', 'endpoint-client-created', 'endpoint-client-changed', 'endpoint-client-revoked', 'endpoint-tool-called'));