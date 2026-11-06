-- Refuse to upgrade until the release after 0.6.11 has proven the move off the old object naming
-- (the storage design, §06). From this release on nothing reads the old naming, so an object only
-- the old naming reaches would vanish from lists and downloads. That release records every adopt
-- and skills pass, a failed one included (`proof_version` 2), so its latest record of each stage is
-- its latest pass; 0.6.11 recorded neither failed nor unchanged passes. A clean record stays true:
-- no release since 0.6.11 creates old-naming data, so what is left of it only shrinks. A database
-- with no stored data and no pass record is a fresh install and passes. Read-only: nothing is
-- deleted or rewritten.
DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "files" WHERE "kind" = 'file' AND "object_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "session_state_blobs" WHERE "object_id" IS NULL) THEN
		RAISE EXCEPTION 'legacy_storage_rows_remain: run the storage migration first (AW_STORAGE_MIGRATE=copy) on the release after 0.6.11 (see the self-hosting guide)';
	END IF;
	IF (EXISTS (SELECT 1 FROM "files" WHERE "kind" = 'file')
			OR EXISTS (SELECT 1 FROM "session_state_blobs")
			OR EXISTS (SELECT 1 FROM "skills")
			OR EXISTS (SELECT 1 FROM "storage_migration_runs"))
		AND NOT (
			EXISTS (
				SELECT 1 FROM (
					SELECT "proof_version", "clean", "legacy_rows" FROM "storage_migration_runs"
					WHERE "stage" = 'adopt' ORDER BY "finished_at" DESC, "id" DESC LIMIT 1
				) AS "latest"
				WHERE "proof_version" = 2 AND "clean" AND "legacy_rows" = 0
			)
			AND EXISTS (
				SELECT 1 FROM (
					SELECT "proof_version", "clean", "legacy_rows" FROM "storage_migration_runs"
					WHERE "stage" = 'skills' ORDER BY "finished_at" DESC, "id" DESC LIMIT 1
				) AS "latest"
				WHERE "proof_version" = 2 AND "clean" AND "legacy_rows" = 0
			)
		) THEN
		RAISE EXCEPTION 'legacy_storage_rows_remain: upgrade through the release after 0.6.11 first: start it once with AW_STORAGE_MIGRATE=copy, then once with AW_STORAGE_MIGRATE=finalize, then once with it unset, until its latest adopt and skills records in storage_migration_runs are clean with legacy_rows 0 (see the self-hosting guide)';
	END IF;
END $$;--> statement-breakpoint
-- safe: the guard above refused while any session-state blob had no object id
ALTER TABLE "session_state_blobs" ALTER COLUMN "object_id" SET NOT NULL;--> statement-breakpoint
-- safe: the guard above refused while any file row had no object id, so the scan finds none
ALTER TABLE "files" ADD CONSTRAINT "files_file_has_object_id" CHECK ("files"."kind" <> 'file' or "files"."object_id" is not null);
