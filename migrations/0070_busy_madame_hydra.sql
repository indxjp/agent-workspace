-- STO-302 (#1657, the storage design, §04): a catalog row gets an object ID, an area, a checksum and a
-- `deleting` state. Expand only: `files_workspace_path_key` stays, so every writer's
-- `ON CONFLICT (workspace_id, path)` keeps working during a rolling deploy; existing rows keep
-- `object_id` NULL (outside `files_workspace_object_key`), `area` 'files' and `sha256` NULL.
-- safe: re-added at the end of this migration, widened with 'deleting'; no row is narrowed
ALTER TABLE "files" DROP CONSTRAINT "files_status_valid";--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "area" text DEFAULT 'files' NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "sha256" text;--> statement-breakpoint
CREATE UNIQUE INDEX "files_workspace_object_key" ON "files" USING btree ("workspace_id","object_id") WHERE "files"."object_id" is not null;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_area_valid" CHECK ("files"."area" in ('files', 'skills', 'session-state', 'artifacts', 'staging'));--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_sha256_shape" CHECK ("files"."sha256" is null or "files"."sha256" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_status_valid" CHECK ("files"."status" in ('pending', 'ready', 'deleting'));