ALTER TABLE "agents" ADD COLUMN "created_by_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_agent_version" integer;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by_run_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_agent_id_agents_id_fk" FOREIGN KEY ("created_by_agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_agent_workspace_fk" FOREIGN KEY ("created_by_agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_created_by_agent_idx" ON "agents" USING btree ("created_by_agent_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_agent_lineage_check" CHECK (("agents"."created_by_agent_version" is null) = ("agents"."created_by_run_id" is null) and ("agents"."created_by_agent_id" is null or "agents"."created_by_agent_version" is not null));