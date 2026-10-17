CREATE TABLE "runtime_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"driver" text NOT NULL,
	"runtime_connection_id" uuid,
	"cpu" integer,
	"memory_mb" integer,
	"disk_mb" integer,
	"network_policy" text NOT NULL,
	"allowed_domains" jsonb,
	"filesystem" text NOT NULL,
	"persist_paths" jsonb,
	"timeout_seconds" integer,
	"idle_timeout_seconds" integer,
	"driver_config" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runtime_profiles_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "runtime_profiles_name_not_blank" CHECK (length(btrim("runtime_profiles"."name")) > 0),
	CONSTRAINT "runtime_profiles_driver_valid" CHECK ("runtime_profiles"."driver" in ('local', 'sandbox-runtime', 'docker', 'kubernetes', 'gke-agent-sandbox', 'aca-sessions', 'aws-agentcore', 'aws-ecs', 'cloud-run-sandbox', 'external')),
	CONSTRAINT "runtime_profiles_network_policy_valid" CHECK ("runtime_profiles"."network_policy" in ('none', 'restricted', 'open')),
	CONSTRAINT "runtime_profiles_filesystem_valid" CHECK ("runtime_profiles"."filesystem" in ('read-only', 'read-write'))
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "runtime_profile_id" uuid;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_runtime_connection_id_secrets_id_fk" FOREIGN KEY ("runtime_connection_id") REFERENCES "public"."secrets"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_runtime_connection_workspace_fk" FOREIGN KEY ("runtime_connection_id","workspace_id") REFERENCES "public"."secrets"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_profiles_workspace_name_key" ON "runtime_profiles" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "runtime_profiles_runtime_connection_idx" ON "runtime_profiles" USING btree ("runtime_connection_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_profile_id_runtime_profiles_id_fk" FOREIGN KEY ("runtime_profile_id") REFERENCES "public"."runtime_profiles"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_runtime_profile_workspace_fk" FOREIGN KEY ("runtime_profile_id","workspace_id") REFERENCES "public"."runtime_profiles"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agents_runtime_profile_idx" ON "agents" USING btree ("runtime_profile_id");