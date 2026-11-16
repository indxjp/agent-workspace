CREATE TABLE IF NOT EXISTS "app_service_desk"."tickets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "title" text NOT NULL,
  "description" jsonb NOT NULL,
  "status" text NOT NULL,
  "priority" text NOT NULL,
  "requester" uuid NOT NULL,
  "assignee" uuid NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '')) || to_tsvector('simple'::regconfig, coalesce("description", '[]'::jsonb))) STORED,
  CONSTRAINT "tickets_title_check" CHECK (char_length("title") <= 10000),
  CONSTRAINT "tickets_description_check" CHECK (jsonb_typeof("description") = 'array'),
  CONSTRAINT "tickets_status_check" CHECK ("status" IN ('new', 'in_progress', 'on_hold', 'resolved', 'closed')),
  CONSTRAINT "tickets_priority_check" CHECK ("priority" IN ('p1', 'p2', 'p3', 'p4'))
);
CREATE INDEX IF NOT EXISTS "tickets_list_idx" ON "app_service_desk"."tickets" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "tickets_search_idx" ON "app_service_desk"."tickets" USING gin ("_search");
