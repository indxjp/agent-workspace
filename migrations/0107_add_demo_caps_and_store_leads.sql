CREATE TABLE "demo_daily_costs" (
	"day" date PRIMARY KEY NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"unpriced_usage" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demo_daily_costs_cost_not_negative" CHECK ("demo_daily_costs"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "demo_run_admissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"client_key" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demo_run_admissions_client_key_shape" CHECK (length("demo_run_admissions"."client_key") between 1 and 256)
);
--> statement-breakpoint
CREATE TABLE "store_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"entries" text[] DEFAULT '{}'::text[] NOT NULL,
	"enquiry" text,
	"created_at" timestamp with time zone NOT NULL,
	"last_contact_at" timestamp with time zone NOT NULL,
	CONSTRAINT "store_leads_email_lower_case" CHECK ("store_leads"."email" = lower("store_leads"."email")),
	CONSTRAINT "store_leads_last_contact_after_created" CHECK ("store_leads"."last_contact_at" >= "store_leads"."created_at")
);
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN "demo_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "demo_run_admissions" ADD CONSTRAINT "demo_run_admissions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "demo_run_admissions_user_created_idx" ON "demo_run_admissions" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "demo_run_admissions_client_created_idx" ON "demo_run_admissions" USING btree ("client_key","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "store_leads_email_key" ON "store_leads" USING btree ("email");--> statement-breakpoint
CREATE INDEX "store_leads_last_contact_idx" ON "store_leads" USING btree ("last_contact_at");--> statement-breakpoint
CREATE INDEX "workspaces_demo_expires_idx" ON "workspaces" USING btree ("demo_expires_at") WHERE "workspaces"."demo_expires_at" is not null;--> statement-breakpoint
-- safe: demo_expires_at is added by this migration and is NULL in every existing row, so no row can violate the check
ALTER TABLE "workspaces" ADD CONSTRAINT "workspaces_demo_expires_after_created" CHECK ("workspaces"."demo_expires_at" is null or "workspaces"."demo_expires_at" > "workspaces"."created_at");