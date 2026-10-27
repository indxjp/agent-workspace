CREATE TABLE "agent_version_storage_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"prefix" text NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_storage_grants_workspace_version_folder_key" UNIQUE("workspace_id","version_id","connection_id","prefix"),
	CONSTRAINT "agent_version_storage_grants_access_valid" CHECK ("agent_version_storage_grants"."access" in ('read', 'read-write'))
);
--> statement-breakpoint
ALTER TABLE "agent_version_storage_grants" ADD CONSTRAINT "agent_version_storage_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_storage_grants" ADD CONSTRAINT "agent_version_storage_grants_version_workspace_fk" FOREIGN KEY ("version_id","workspace_id") REFERENCES "public"."agent_versions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_storage_grants" ADD CONSTRAINT "agent_version_storage_grants_connection_workspace_fk" FOREIGN KEY ("connection_id","workspace_id") REFERENCES "public"."storage_connections"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_version_storage_grants_connection_idx" ON "agent_version_storage_grants" USING btree ("connection_id");