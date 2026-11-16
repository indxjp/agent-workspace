CREATE TABLE IF NOT EXISTS "app_team_chat"."channels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "name" text NOT NULL,
  "kind" text NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", ''))) STORED,
  CONSTRAINT "channels_name_check" CHECK (char_length("name") <= 10000),
  CONSTRAINT "channels_kind_check" CHECK ("kind" IN ('public', 'private', 'dm'))
);
CREATE INDEX IF NOT EXISTS "channels_list_idx" ON "app_team_chat"."channels" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "channels_search_idx" ON "app_team_chat"."channels" USING gin ("_search");
