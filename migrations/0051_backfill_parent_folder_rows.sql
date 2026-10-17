-- Custom SQL migration file, put your code below! --
-- A file or folder implies its parent folders: `putFile` now writes those rows (issue #899).
-- Rows written before that have no parent rows, so a `files('<folder>')` grant on them cannot
-- resolve. Insert-only and idempotent: an existing row at a parent path, folder or file, is kept.
-- The oldest child supplies the owner, so the result is deterministic.
INSERT INTO "files" ("workspace_id", "path", "kind", "owner_principal_id", "created_by")
SELECT DISTINCT ON (f."workspace_id", parent."path")
  f."workspace_id", parent."path", 'folder', f."owner_principal_id", f."created_by"
FROM "files" AS f
CROSS JOIN LATERAL (
  SELECT array_to_string((string_to_array(f."path", '/'))[1:n], '/') AS "path"
  FROM generate_series(1, cardinality(string_to_array(f."path", '/')) - 1) AS n
) AS parent
ORDER BY f."workspace_id", parent."path", f."created_at", f."id"
ON CONFLICT ("workspace_id", "path") DO NOTHING;
