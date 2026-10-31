CREATE TABLE "webhook_deliveries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"webhook_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"attempts" smallint DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_status_code" integer,
	"last_error" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhook_deliveries_state_valid" CHECK ("webhook_deliveries"."state" in ('pending', 'delivered', 'failed')),
	CONSTRAINT "webhook_deliveries_event_type_valid" CHECK ("webhook_deliveries"."event_type" = any(ARRAY['run.completed', 'run.failed', 'run.cancelled']::text[])),
	CONSTRAINT "webhook_deliveries_delivered_shape" CHECK (("webhook_deliveries"."state" = 'delivered') = ("webhook_deliveries"."delivered_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "webhooks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"url" text NOT NULL,
	"events" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "webhooks_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "webhooks_url_length" CHECK (char_length("webhooks"."url") between 1 and 2048),
	CONSTRAINT "webhooks_events_valid" CHECK (cardinality("webhooks"."events") between 1 and 3 and "webhooks"."events" <@ ARRAY['run.completed', 'run.failed', 'run.cancelled']::text[])
);
--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_webhook_workspace_fk" FOREIGN KEY ("workspace_id","webhook_id") REFERENCES "public"."webhooks"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "webhooks" ADD CONSTRAINT "webhooks_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_webhook_run_key" ON "webhook_deliveries" USING btree ("workspace_id","webhook_id","run_id");--> statement-breakpoint
CREATE INDEX "webhook_deliveries_pending_due_idx" ON "webhook_deliveries" USING btree ("next_attempt_at") WHERE "webhook_deliveries"."state" = 'pending';--> statement-breakpoint
CREATE INDEX "webhook_deliveries_settled_created_idx" ON "webhook_deliveries" USING btree ("created_at") WHERE "webhook_deliveries"."state" <> 'pending';