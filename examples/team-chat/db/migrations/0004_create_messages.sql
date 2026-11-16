CREATE TABLE IF NOT EXISTS "app_team_chat"."messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "channel" uuid NOT NULL,
  "body" jsonb NOT NULL,
  "attachments" uuid[],
  "thread_root" uuid,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("body", '[]'::jsonb))) STORED,
  CONSTRAINT "messages_body_check" CHECK (jsonb_typeof("body") = 'array'),
  CONSTRAINT "messages_attachments_check" CHECK (cardinality("attachments") <= 100)
);
CREATE INDEX IF NOT EXISTS "messages_list_idx" ON "app_team_chat"."messages" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "messages_search_idx" ON "app_team_chat"."messages" USING gin ("_search");
