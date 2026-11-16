CREATE TABLE IF NOT EXISTS "app_crm"."deals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "workspace_id" text NOT NULL,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "name" text NOT NULL,
  "amount" numeric NOT NULL,
  "amount_currency" text NOT NULL,
  "stage" text NOT NULL,
  "owner" uuid NOT NULL,
  "_search" tsvector GENERATED ALWAYS AS (to_tsvector('simple'::regconfig, coalesce("name", ''))) STORED,
  CONSTRAINT "deals_name_check" CHECK (char_length("name") <= 10000),
  CONSTRAINT "deals_amount_currency_check" CHECK ("amount_currency" = 'JPY'),
  CONSTRAINT "deals_stage_check" CHECK ("stage" IN ('lead', 'qualified', 'proposal', 'won', 'lost'))
);
CREATE INDEX IF NOT EXISTS "deals_list_idx" ON "app_crm"."deals" ("workspace_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "deals_search_idx" ON "app_crm"."deals" USING gin ("_search");
