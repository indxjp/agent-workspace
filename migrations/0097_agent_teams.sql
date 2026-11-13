CREATE TABLE "agent_team_version_members" (
	"team_version_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"agent_version_id" uuid NOT NULL,
	"name" text NOT NULL,
	CONSTRAINT "agent_team_version_members_pkey" PRIMARY KEY("team_version_id","agent_id"),
	CONSTRAINT "agent_team_version_members_workspace_version_name_key" UNIQUE("workspace_id","team_version_id","name"),
	CONSTRAINT "agent_team_version_members_name_valid" CHECK ("agent_team_version_members"."name" ~ '^[a-z0-9][a-z0-9_-]*$' and char_length("agent_team_version_members"."name") <= 52)
);
--> statement-breakpoint
CREATE TABLE "agent_team_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"team_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"mode" text NOT NULL,
	"lead_agent_id" uuid NOT NULL,
	"lead_agent_version_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_team_versions_workspace_team_number_key" UNIQUE("workspace_id","team_id","number"),
	CONSTRAINT "agent_team_versions_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "agent_team_versions_mode_valid" CHECK ("agent_team_versions"."mode" in ('handoff')),
	CONSTRAINT "agent_team_versions_number_positive" CHECK ("agent_team_versions"."number" > 0)
);
--> statement-breakpoint
CREATE TABLE "agent_teams" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"owner_principal_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "agent_teams_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "agent_teams_name_not_blank" CHECK (length(btrim("agent_teams"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "parent_run_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_team_version_members" ADD CONSTRAINT "agent_team_version_members_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_version_members" ADD CONSTRAINT "agent_team_version_members_version_workspace_fk" FOREIGN KEY ("team_version_id","workspace_id") REFERENCES "public"."agent_team_versions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_version_members" ADD CONSTRAINT "agent_team_version_members_agent_version_fk" FOREIGN KEY ("agent_version_id","agent_id","workspace_id") REFERENCES "public"."agent_versions"("id","agent_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_versions" ADD CONSTRAINT "agent_team_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_versions" ADD CONSTRAINT "agent_team_versions_team_workspace_fk" FOREIGN KEY ("team_id","workspace_id") REFERENCES "public"."agent_teams"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_versions" ADD CONSTRAINT "agent_team_versions_lead_version_fk" FOREIGN KEY ("lead_agent_version_id","lead_agent_id","workspace_id") REFERENCES "public"."agent_versions"("id","agent_id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_team_versions" ADD CONSTRAINT "agent_team_versions_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_teams" ADD CONSTRAINT "agent_teams_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_teams_workspace_name_key" ON "agent_teams" USING btree ("workspace_id","name") WHERE "agent_teams"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_workspace_fk" FOREIGN KEY ("parent_run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_parent_idx" ON "runs" USING btree ("parent_run_id");--> statement-breakpoint
-- safe: parent_run_id was added NULL above and nothing writes it yet, so every row satisfies the CHECK
ALTER TABLE "runs" ADD CONSTRAINT "runs_parent_not_self" CHECK ("runs"."parent_run_id" <> "runs"."id");