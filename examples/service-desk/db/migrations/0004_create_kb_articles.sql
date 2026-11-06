CREATE TABLE IF NOT EXISTS "app_service_desk"."kb_articles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "title" text NOT NULL,
  "body" jsonb NOT NULL,
  "tags" text[] NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("title", '')) || to_tsvector('simple'::regconfig, coalesce("body", '[]'::jsonb))) STORED,
  CONSTRAINT "kb_articles_title_check" CHECK (char_length("title") <= 10000),
  CONSTRAINT "kb_articles_body_check" CHECK (jsonb_typeof("body") = 'array'),
  CONSTRAINT "kb_articles_tags_check" CHECK (cardinality("tags") <= 100)
);
CREATE INDEX IF NOT EXISTS "kb_articles_list_idx" ON "app_service_desk"."kb_articles" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "kb_articles_search_idx" ON "app_service_desk"."kb_articles" USING gin ("_search");
