-- Refuse to upgrade while a file or session-state blob still has no object id (the storage design,
-- §06): such a row is read through the old-naming bridge, and only the previous release's storage
-- migration (`AW_STORAGE_MIGRATE=copy`) gives it one. Read-only: nothing is deleted or rewritten.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "files" WHERE "kind" = 'file' AND "object_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "session_state_blobs" WHERE "object_id" IS NULL) THEN
		RAISE EXCEPTION 'legacy_storage_rows_remain: run the storage migration first (AW_STORAGE_MIGRATE=copy)';
	END IF;
END $$;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD COLUMN "stage" text DEFAULT 'finalize' NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD COLUMN "skipped_ownerless" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD COLUMN "skipped_path_taken" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD COLUMN "skipped_failed" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD COLUMN "clean" boolean;--> statement-breakpoint
ALTER TABLE "storage_migration_runs" ADD CONSTRAINT "storage_migration_runs_stage_valid" CHECK ("storage_migration_runs"."stage" in ('finalize', 'skills', 'adopt'));