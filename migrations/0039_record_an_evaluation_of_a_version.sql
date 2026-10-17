CREATE TABLE "agent_version_evaluations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"score" numeric(5, 4) NOT NULL,
	"passed" integer NOT NULL,
	"total" integer NOT NULL,
	"cases_snapshot" jsonb NOT NULL,
	"results" jsonb NOT NULL,
	"created_by_principal_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_version_evaluations_counts" CHECK ("agent_version_evaluations"."total" > 0 and "agent_version_evaluations"."passed" >= 0 and "agent_version_evaluations"."passed" <= "agent_version_evaluations"."total")
);
--> statement-breakpoint
ALTER TABLE "agent_version_evaluations" ADD CONSTRAINT "agent_version_evaluations_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_evaluations" ADD CONSTRAINT "agent_version_evaluations_version_workspace_fk" FOREIGN KEY ("version_id","workspace_id") REFERENCES "public"."agent_versions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_version_evaluations" ADD CONSTRAINT "agent_version_evaluations_created_by_principal_workspace_fk" FOREIGN KEY ("workspace_id","created_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_version_evaluations_workspace_version_idx" ON "agent_version_evaluations" USING btree ("workspace_id","version_id");