-- Issue #442 (S1-04, ADR-0101): the agent version store. `agent_versions` holds each agent's
-- immutable, numbered definitions and `agent_version_pointers` records which version is live in an
-- environment. The pointer → version FK carries `workspace_id` as a third column so the reference is
-- tenant-paired (tenancy.test.ts bucket 3). Additive: it creates two tables with their constraints
-- and index, and no revision from the previous release reads or writes them, so no single-revision
-- cutover is needed (ADR-0069). Numbered 0033 so the file prefix equals the journal idx (33).
CREATE TABLE "agent_version_pointers" (
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"environment" text NOT NULL,
	"version_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_pointers_pkey" PRIMARY KEY("agent_id","environment"),
	CONSTRAINT "agent_version_pointers_environment_valid" CHECK ("agent_version_pointers"."environment" in ('local'))
);
--> statement-breakpoint
CREATE TABLE "agent_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"summary" text NOT NULL,
	"via" text NOT NULL,
	"body" jsonb NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_versions_workspace_agent_number_key" UNIQUE("workspace_id","agent_id","number"),
	CONSTRAINT "agent_versions_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "agent_versions_id_agent_workspace_key" UNIQUE("id","agent_id","workspace_id"),
	CONSTRAINT "agent_versions_via_valid" CHECK ("agent_versions"."via" in ('ui', 'aw-push', 'api')),
	CONSTRAINT "agent_versions_number_positive" CHECK ("agent_versions"."number" > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_version_pointers" ADD CONSTRAINT "agent_version_pointers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_pointers" ADD CONSTRAINT "agent_version_pointers_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_pointers" ADD CONSTRAINT "agent_version_pointers_version_fk" FOREIGN KEY ("version_id","agent_id","workspace_id") REFERENCES "public"."agent_versions"("id","agent_id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_versions" ADD CONSTRAINT "agent_versions_created_by_principal_workspace_fk" FOREIGN KEY ("workspace_id","created_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_version_pointers_workspace_environment_idx" ON "agent_version_pointers" USING btree ("workspace_id","environment");