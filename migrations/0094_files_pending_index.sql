-- Every reserve counts the workspace's pending uploads (STO-113 #2); this partial index holds only
-- the pending rows, so the count no longer reads the workspace's ready rows. It is not built
-- CONCURRENTLY: the migrator runs every pending migration in one transaction, where PostgreSQL
-- refuses CREATE INDEX CONCURRENTLY. The build takes a SHARE lock on "files" (reads go on, writes
-- wait) for one scan of the table.
CREATE INDEX "files_workspace_pending_updated_idx" ON "files" USING btree ("workspace_id","updated_at") WHERE "files"."status" = 'pending';