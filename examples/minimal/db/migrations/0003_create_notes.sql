CREATE TABLE IF NOT EXISTS "app_minimal"."notes" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "title" text NOT NULL,
  "body" jsonb NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '')) || to_tsvector('simple'::regconfig, coalesce("body", '[]'::jsonb))) STORED,
  CONSTRAINT "notes_title_check" CHECK (char_length("title") <= 10000),
  CONSTRAINT "notes_body_check" CHECK (jsonb_typeof("body") = 'array')
);
CREATE INDEX IF NOT EXISTS "notes_list_idx" ON "app_minimal"."notes" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "notes_search_idx" ON "app_minimal"."notes" USING gin ("_search");
