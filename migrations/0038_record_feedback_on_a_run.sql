CREATE TABLE "run_feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"rating" text NOT NULL,
	"comment" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_feedback_rating_valid" CHECK ("run_feedback"."rating" in ('up', 'down')),
	CONSTRAINT "run_feedback_comment_length" CHECK ("run_feedback"."comment" is null or char_length("run_feedback"."comment") <= 1000)
);
--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_feedback" ADD CONSTRAINT "run_feedback_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_feedback_workspace_run_idx" ON "run_feedback" USING btree ("workspace_id","run_id");