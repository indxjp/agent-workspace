CREATE TABLE "run_usage_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"provider_response_id" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_tokens" integer NOT NULL,
	"output_tokens" integer NOT NULL,
	"cache_read_input_tokens" integer DEFAULT 0 NOT NULL,
	"cache_creation_input_tokens" integer DEFAULT 0 NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) NOT NULL,
	"cost_currency" text DEFAULT 'USD' NOT NULL,
	"price_table_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_usage_records_counters_non_negative" CHECK ("run_usage_records"."input_tokens" >= 0 and "run_usage_records"."output_tokens" >= 0 and "run_usage_records"."cache_read_input_tokens" >= 0 and "run_usage_records"."cache_creation_input_tokens" >= 0 and "run_usage_records"."tool_calls" >= 0 and "run_usage_records"."cost_usd" >= 0),
	CONSTRAINT "run_usage_records_currency_usd" CHECK ("run_usage_records"."cost_currency" = 'USD')
);
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT "runs_counters_non_negative";--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cache_read_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cache_creation_input_tokens" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cost_currency" text DEFAULT 'USD' NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "price_table_version" text;--> statement-breakpoint
ALTER TABLE "run_usage_records" ADD CONSTRAINT "run_usage_records_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_usage_records" ADD CONSTRAINT "run_usage_records_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_usage_records_response_unique" ON "run_usage_records" USING btree ("run_id","provider_response_id");--> statement-breakpoint
CREATE INDEX "run_usage_records_workspace_run_idx" ON "run_usage_records" USING btree ("workspace_id","run_id");--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_cost_currency_usd" CHECK ("runs"."cost_currency" = 'USD');--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_counters_non_negative" CHECK ("runs"."input_tokens" >= 0 and "runs"."output_tokens" >= 0 and "runs"."cache_read_input_tokens" >= 0 and "runs"."cache_creation_input_tokens" >= 0 and "runs"."tool_calls" >= 0 and "runs"."cost_usd" >= 0);