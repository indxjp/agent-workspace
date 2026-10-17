ALTER TABLE "projects" ADD COLUMN "default_model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_model_connection_id" uuid;--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "default_model" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_model_connection_id_model_connections_id_fk" FOREIGN KEY ("default_model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_model_connection_workspace_fk" FOREIGN KEY ("default_model_connection_id","workspace_id") REFERENCES "public"."model_connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_connection_id_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_model_connection_workspace_fk" FOREIGN KEY ("model_connection_id","workspace_id") REFERENCES "public"."model_connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_model_connection_id_model_connections_id_fk" FOREIGN KEY ("default_model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_model_connection_workspace_fk" FOREIGN KEY ("default_model_connection_id","id") REFERENCES "public"."model_connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "runs_model_connection_idx" ON "runs" USING btree ("model_connection_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_default_model_pair" CHECK (("projects"."default_model_connection_id" is null) = ("projects"."default_model" is null));--> statement-breakpoint
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_default_model_pair" CHECK (("workspaces"."default_model_connection_id" is null) = ("workspaces"."default_model" is null));