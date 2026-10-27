CREATE TABLE "trigger_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"trigger_id" uuid NOT NULL,
	"delivery_key" text NOT NULL,
	"run_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trigger_deliveries_key_length" CHECK (char_length("trigger_deliveries"."delivery_key") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "triggers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"prompt_template" text NOT NULL,
	"cron" text,
	"timezone" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"owner_principal_id" uuid NOT NULL,
	"secret_hash" text,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "triggers_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "triggers_kind_valid" CHECK ("triggers"."kind" in ('webhook', 'schedule')),
	CONSTRAINT "triggers_secret_hash_sha256_hex" CHECK ("triggers"."secret_hash" is null or "triggers"."secret_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "triggers_kind_shape" CHECK (("triggers"."kind" = 'webhook' and "triggers"."secret_hash" is not null and "triggers"."cron" is null and "triggers"."timezone" is null)
        or ("triggers"."kind" = 'schedule' and "triggers"."secret_hash" is null and "triggers"."cron" is not null and "triggers"."timezone" is not null))
);
--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_trigger_workspace_fk" FOREIGN KEY ("workspace_id","trigger_id") REFERENCES "public"."triggers"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "trigger_deliveries" ADD CONSTRAINT "trigger_deliveries_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "triggers" ADD CONSTRAINT "triggers_owner_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "trigger_deliveries_trigger_key_key" ON "trigger_deliveries" USING btree ("workspace_id","trigger_id","delivery_key");--> statement-breakpoint
CREATE UNIQUE INDEX "triggers_workspace_name_key" ON "triggers" USING btree ("workspace_id","name");