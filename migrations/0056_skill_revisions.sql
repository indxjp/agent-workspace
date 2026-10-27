CREATE TABLE "skill_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"number" integer NOT NULL,
	"file_count" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skill_revisions_workspace_skill_number_key" UNIQUE("workspace_id","skill_id","number"),
	CONSTRAINT "skill_revisions_number_positive" CHECK ("skill_revisions"."number" >= 1),
	CONSTRAINT "skill_revisions_file_count_positive" CHECK ("skill_revisions"."file_count" >= 1)
);
--> statement-breakpoint
ALTER TABLE "agent_skills" ADD COLUMN "revision" integer;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_revisions" ADD CONSTRAINT "skill_revisions_skill_workspace_fk" FOREIGN KEY ("skill_id","workspace_id") REFERENCES "public"."skills"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_revision_fk" FOREIGN KEY ("workspace_id","skill_id","revision") REFERENCES "public"."skill_revisions"("workspace_id","skill_id","number") ON DELETE cascade ON UPDATE no action;