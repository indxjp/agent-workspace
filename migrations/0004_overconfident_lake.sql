CREATE TABLE "run_events" (
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"type" text NOT NULL,
	"data" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_events_pkey" PRIMARY KEY("run_id","sequence")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "runs_id_workspace_unique" ON "runs" USING btree ("id","workspace_id");
--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_events" ADD CONSTRAINT "run_events_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "run_events_workspace_sequence_idx" ON "run_events" USING btree ("workspace_id","run_id","sequence");--> statement-breakpoint
CREATE INDEX "run_events_run_sequence_idx" ON "run_events" USING btree ("run_id","sequence");
