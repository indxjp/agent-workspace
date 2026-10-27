-- Per-version storage grants (the storage design, §05). Until now only the agent's current
-- `agent_storage_grants` existed, written from its materialised version. Copy those rows to the
-- materialised version, keeping their ids and connection ids. Every other existing version gets no
-- row and fails closed at run time: a name is never resolved again to bind it. Insert-only and
-- idempotent.
INSERT INTO "agent_version_storage_grants" ("id", "workspace_id", "version_id", "connection_id", "prefix", "access", "created_at")
SELECT g."id", g."workspace_id", a."materialised_version_id", g."connection_id", g."prefix", g."access", g."created_at"
FROM "agent_storage_grants" AS g
JOIN "agents" AS a ON a."id" = g."agent_id" AND a."workspace_id" = g."workspace_id"
WHERE a."materialised_version_id" IS NOT NULL
ON CONFLICT DO NOTHING;
