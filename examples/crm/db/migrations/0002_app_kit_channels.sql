CREATE TABLE IF NOT EXISTS "app_crm"."app_channel_events" (
  "id" bigserial PRIMARY KEY,
  "workspace_id" uuid NOT NULL,
  "channel" text NOT NULL,
  "key" text NOT NULL,
  "type" text NOT NULL,
  "data" jsonb NOT NULL,
  "at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "app_channel_events_key_idx" ON "app_crm"."app_channel_events" ("workspace_id", "channel", "key", "id");
