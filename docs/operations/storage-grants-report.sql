-- Agent versions whose storage folders cannot be bound at run time (#1835).
--
-- A run reads its version's own grant rows (agent_version_storage_grants), never its storage://
-- names resolved again. A version that grants more folders than it has rows is refused with
-- run_storage_grant_unavailable: it was deployed before grants were recorded per version (0.6.x
-- before per-version grants, or by an older pod during the upgrade), or a connection it grants was
-- deleted since. Redeploy each listed version, or point its environments at a version that runs.
--
-- Read-only. Run it with psql against the deployment's database:
--   psql "$DATABASE_URL" -f docs/operations/storage-grants-report.sql
-- `materialised` is true for the version the agent row was last written from (`local`'s);
-- `environments` names the pointers on it, empty for a version only an older session pins.
SELECT
  w.slug AS workspace,
  a.id AS agent_id,
  a.name AS agent,
  v.number AS version,
  (a.materialised_version_id IS NOT DISTINCT FROM v.id) AS materialised,
  coalesce(
    (
      SELECT string_agg(p.environment, ', ' ORDER BY p.environment)
      FROM agent_version_pointers AS p
      WHERE p.version_id = v.id AND p.workspace_id = v.workspace_id
    ),
    ''
  ) AS environments,
  granted.folders AS granted_folders,
  bound.folders AS bound_folders
FROM agent_versions AS v
JOIN agents AS a ON a.id = v.agent_id AND a.workspace_id = v.workspace_id
JOIN workspaces AS w ON w.id = v.workspace_id
CROSS JOIN LATERAL (
  SELECT count(DISTINCT file ->> 'path')::int AS folders
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(v.body -> 'definition' -> 'resources' -> 'files') = 'array'
        THEN v.body -> 'definition' -> 'resources' -> 'files'
      ELSE '[]'::jsonb
    END
  ) AS file
  WHERE file ->> 'path' LIKE 'storage://%'
) AS granted
CROSS JOIN LATERAL (
  SELECT count(*)::int AS folders
  FROM agent_version_storage_grants AS g
  WHERE g.version_id = v.id AND g.workspace_id = v.workspace_id
) AS bound
WHERE granted.folders > bound.folders
ORDER BY w.slug, a.name, a.id, v.number;
