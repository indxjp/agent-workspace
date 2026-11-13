CREATE TABLE IF NOT EXISTS "app_crm"."contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "name" text NOT NULL,
  "email" text NOT NULL,
  "company" uuid,
  "owner" uuid NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", '')) || to_tsvector('simple'::regconfig, coalesce("email", ''))) STORED,
  CONSTRAINT "contacts_name_check" CHECK (char_length("name") <= 10000),
  CONSTRAINT "contacts_email_check" CHECK (char_length("email") <= 10000)
);
CREATE INDEX IF NOT EXISTS "contacts_list_idx" ON "app_crm"."contacts" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "contacts_search_idx" ON "app_crm"."contacts" USING gin ("_search");
