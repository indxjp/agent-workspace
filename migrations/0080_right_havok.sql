CREATE TABLE "builder_tool_calls" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" text NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"decision" text NOT NULL,
	"outcome" text NOT NULL,
	"code" text,
	"input_json" jsonb NOT NULL,
	"result_json" jsonb,
	"trace_id" text NOT NULL,
	"model_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "builder_tool_calls_run_call_key" UNIQUE("workspace_id","run_id","call_id"),
	CONSTRAINT "builder_tool_calls_tool_valid" CHECK ("builder_tool_calls"."tool" in ('catalog_list', 'examples_get', 'draft_check', 'draft_save', 'evals_run', 'trial_run')),
	CONSTRAINT "builder_tool_calls_decision_valid" CHECK ("builder_tool_calls"."decision" in ('refuse', 'ask', 'run')),
	CONSTRAINT "builder_tool_calls_outcome_valid" CHECK ("builder_tool_calls"."outcome" in ('ok', 'refused', 'check_failed', 'error'))
);
--> statement-breakpoint
ALTER TABLE "builder_tool_calls" ADD CONSTRAINT "builder_tool_calls_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "builder_tool_calls_run_created_idx" ON "builder_tool_calls" USING btree ("workspace_id","run_id","created_at");