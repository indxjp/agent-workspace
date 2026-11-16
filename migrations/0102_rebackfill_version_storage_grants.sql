-- 0083 again, for the rollout window (#1835). A pod older than per-version grants that kept serving
-- after 0083 ran could create or materialise a version without writing its rows, and that version
-- fails closed (`run_storage_grant_unavailable`) until it is redeployed. Copy the agent's current
-- grants to its materialised version, keeping their ids, as 0083 did, but only when the version has
-- no row at all (a version a newer pod wrote is never touched), and only for a connection created
-- no later than the version: a connection recreated afterwards under the same name is another
-- connection and is never bound to an old version. Insert-only and idempotent.
INSERT INTO "agent_version_storage_grants" ("id", "workspace_id", "version_id", "connection_id", "prefix", "access", "created_at")
SELECT g."id", g."workspace_id", v."id", g."connection_id", g."prefix", g."access", g."created_at"
FROM "agent_storage_grants" AS g
JOIN "agents" AS a ON a."id" = g."agent_id" AND a."workspace_id" = g."workspace_id"
JOIN "agent_versions" AS v ON v."id" = a."materialised_version_id" AND v."workspace_id" = a."workspace_id"
JOIN "storage_connections" AS c ON c."id" = g."connection_id" AND c."workspace_id" = g."workspace_id"
WHERE c."created_at" <= v."created_at"
  AND NOT EXISTS (
    SELECT 1 FROM "agent_version_storage_grants" AS r
    WHERE r."version_id" = v."id" AND r."workspace_id" = v."workspace_id"
  )
ON CONFLICT DO NOTHING;
