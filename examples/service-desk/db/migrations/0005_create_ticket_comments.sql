CREATE TABLE IF NOT EXISTS "app_service_desk"."ticket_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "ticket" uuid NOT NULL,
  "body" jsonb NOT NULL,
  "internal" boolean NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("body", '[]'::jsonb))) STORED,
  CONSTRAINT "ticket_comments_body_check" CHECK (jsonb_typeof("body") = 'array')
);
CREATE INDEX IF NOT EXISTS "ticket_comments_list_idx" ON "app_service_desk"."ticket_comments" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "ticket_comments_search_idx" ON "app_service_desk"."ticket_comments" USING gin ("_search");
