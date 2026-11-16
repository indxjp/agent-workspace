CREATE TABLE IF NOT EXISTS "app_crm"."companys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "name" text NOT NULL,
  "domain" text NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", '')) || to_tsvector('simple'::regconfig, coalesce("domain", ''))) STORED,
  CONSTRAINT "companys_name_check" CHECK (char_length("name") <= 10000),
  CONSTRAINT "companys_domain_check" CHECK (char_length("domain") <= 10000)
);
CREATE INDEX IF NOT EXISTS "companys_list_idx" ON "app_crm"."companys" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "companys_search_idx" ON "app_crm"."companys" USING gin ("_search");
