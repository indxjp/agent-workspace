CREATE TABLE IF NOT EXISTS "app_minimal"."app_audit_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "actor" text NOT NULL,
  "via" text NOT NULL,
  "run_id" text,
  "resource" text NOT NULL,
  "record_id" uuid NOT NULL,
  "action" text NOT NULL,
  "fields" text[] NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "app_audit_events_action_check" CHECK ("action" IN ('create', 'update', 'delete')),
  CONSTRAINT "app_audit_events_via_check" CHECK ("via" IN ('person', 'agent')),
  CONSTRAINT "app_audit_events_agent_run_check" CHECK ("via" <> 'agent' OR "run_id" IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS "app_audit_events_list_idx" ON "app_minimal"."app_audit_events" ("workspace_id", "at" DESC, "id" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "app_minimal"."agent_panel_sessions" (
  "workspace_id" text NOT NULL,
  "resource" text NOT NULL,
  "record_id" uuid NOT NULL,
  "agent" text NOT NULL,
  "principal_id" text NOT NULL,
  "session_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agent_panel_sessions_pkey" PRIMARY KEY ("workspace_id", "resource", "record_id", "agent", "principal_id", "session_id")
);
