CREATE TABLE "project_files" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	CONSTRAINT "project_files_project_id_file_id_pk" PRIMARY KEY("project_id","file_id")
);
--> statement-breakpoint
CREATE TABLE "project_mcp_servers" (
	"workspace_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	CONSTRAINT "project_mcp_servers_project_id_mcp_server_id_pk" PRIMARY KEY("project_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text,
	"default_agent_id" uuid,
	"visibility" text DEFAULT 'private' NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "projects_visibility_valid" CHECK ("projects"."visibility" in ('private', 'workspace', 'public')),
	CONSTRAINT "projects_name_not_blank" CHECK (length(btrim("projects"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "share_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"visitor_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shares" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token" text NOT NULL,
	"subject_type" text NOT NULL,
	"subject_id" text NOT NULL,
	"subject_label" text NOT NULL,
	"visibility" text NOT NULL,
	"mode" text,
	"snapshot" jsonb,
	"include" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"budget_cap_usd" numeric(12, 4),
	"spent_usd" numeric(12, 4) DEFAULT '0' NOT NULL,
	"stopped" boolean DEFAULT false NOT NULL,
	"expires_at" timestamp with time zone,
	"passphrase_hash" text,
	"created_by" uuid NOT NULL,
	"revoked_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shares_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "shares_token_key" UNIQUE("token"),
	CONSTRAINT "shares_subject_type_valid" CHECK ("shares"."subject_type" in ('agent', 'session', 'project', 'skill')),
	CONSTRAINT "shares_visibility_valid" CHECK ("shares"."visibility" in ('private', 'workspace', 'public')),
	CONSTRAINT "shares_mode_valid" CHECK ("shares"."mode" is null or "shares"."mode" in ('definition', 'runnable')),
	CONSTRAINT "shares_agent_mode_only" CHECK ("shares"."mode" is null or "shares"."subject_type" = 'agent'),
	CONSTRAINT "shares_budget_nonnegative" CHECK ("shares"."budget_cap_usd" is null or "shares"."budget_cap_usd" >= 0),
	CONSTRAINT "shares_spend_nonnegative" CHECK ("shares"."spent_usd" >= 0),
	CONSTRAINT "shares_subject_id_not_blank" CHECK (length(btrim("shares"."subject_id")) > 0)
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "project_id" uuid;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_files" ADD CONSTRAINT "project_files_file_workspace_fk" FOREIGN KEY ("file_id","workspace_id") REFERENCES "public"."files"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_mcp_servers" ADD CONSTRAINT "project_mcp_servers_server_workspace_fk" FOREIGN KEY ("mcp_server_id","workspace_id") REFERENCES "public"."mcp_servers"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_agent_workspace_fk" FOREIGN KEY ("default_agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_views" ADD CONSTRAINT "share_views_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_views" ADD CONSTRAINT "share_views_share_workspace_fk" FOREIGN KEY ("share_id","workspace_id") REFERENCES "public"."shares"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_creator_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_files_workspace_idx" ON "project_files" USING btree ("workspace_id");--> statement-breakpoint
CREATE INDEX "project_mcp_servers_workspace_idx" ON "project_mcp_servers" USING btree ("workspace_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_workspace_name_key" ON "projects" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "projects_default_agent_idx" ON "projects" USING btree ("default_agent_id");--> statement-breakpoint
CREATE INDEX "share_views_workspace_share_created_idx" ON "share_views" USING btree ("workspace_id","share_id","created_at");--> statement-breakpoint
CREATE INDEX "shares_workspace_created_idx" ON "shares" USING btree ("workspace_id","created_at");--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_project_workspace_fk" FOREIGN KEY ("project_id","workspace_id") REFERENCES "public"."projects"("id","workspace_id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_project_idx" ON "sessions" USING btree ("project_id");