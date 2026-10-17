-- RF-101 is intentionally one transactional migration because the repository's Drizzle
-- migrator wraps every pending statement in a single transaction. The set-based backfill below
-- is therefore atomic, but it is not an online/bounded-batch job: locks and WAL are retained until
-- commit. Deployments must rehearse production-shaped row counts and coordinate the DDL lock
-- window. Compatibility triggers installed below keep prior-version human writers working after
-- commit; CREATE INDEX CONCURRENTLY still cannot run inside this migrator transaction.
CREATE TABLE "workspace_principals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"membership_id" uuid,
	"api_key_id" uuid,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspace_principals_workspace_id_key" UNIQUE("workspace_id","id"),
	CONSTRAINT "workspace_principals_workspace_membership_key" UNIQUE("workspace_id","membership_id"),
	CONSTRAINT "workspace_principals_workspace_api_key_key" UNIQUE("workspace_id","api_key_id"),
	CONSTRAINT "workspace_principals_kind_valid" CHECK ("workspace_principals"."kind" in ('membership', 'api_key')),
	CONSTRAINT "workspace_principals_source_xor" CHECK (("workspace_principals"."kind" = 'membership' and "workspace_principals"."membership_id" is not null and "workspace_principals"."api_key_id" is null)
        or ("workspace_principals"."kind" = 'api_key' and "workspace_principals"."api_key_id" is not null and "workspace_principals"."membership_id" is null)),
	CONSTRAINT "workspace_principals_revoked_after_activation" CHECK ("workspace_principals"."revoked_at" is null or "workspace_principals"."revoked_at" >= "workspace_principals"."activated_at")
);
--> statement-breakpoint
-- The redundant workspace/id keys are the tenant-paired FK targets. Primary keys prove global
-- uniqueness, while these constraints also prove that a source belongs to this workspace.
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_key" UNIQUE("workspace_id","id");--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_membership_workspace_fk" FOREIGN KEY ("workspace_id","membership_id") REFERENCES "public"."memberships"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_api_key_workspace_fk" FOREIGN KEY ("workspace_id","api_key_id") REFERENCES "public"."api_keys"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Every existing source receives exactly one principal. Source timestamps preserve when the
-- identity became active; revoked API keys remain historical principals and cannot authenticate.
INSERT INTO "workspace_principals" ("workspace_id", "kind", "membership_id", "activated_at")
SELECT m."workspace_id", 'membership', m."id", m."created_at"
FROM "memberships" AS m
ON CONFLICT ("workspace_id", "membership_id") DO NOTHING;--> statement-breakpoint
INSERT INTO "workspace_principals" ("workspace_id", "kind", "api_key_id", "activated_at", "revoked_at")
SELECT k."workspace_id", 'api_key', k."id", k."created_at", k."revoked_at"
FROM "api_keys" AS k
ON CONFLICT ("workspace_id", "api_key_id") DO NOTHING;--> statement-breakpoint

-- Compatibility columns stay available for human rows, but become nullable so a machine-owned
-- row is never stamped with an invented human. Principal columns are added nullable for the
-- backfill and tightened only after the invariant queries below succeed.
ALTER TABLE "agents" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "actor_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "shares" ADD COLUMN "publisher_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "owner_principal_id" uuid;--> statement-breakpoint

-- Rolling compatibility. A prior-version process knows only the legacy human user columns. It
-- must neither fail against the new NOT NULL columns nor invent a principal. Resolve the exact
-- same-workspace Membership principal, creating it on demand only when the Membership itself is
-- real. Machine writers must continue to supply their API-key principal explicitly.
CREATE FUNCTION "public"."rf101_compat_membership_principal_id"("target_workspace_id" uuid, "target_user_id" uuid)
RETURNS uuid
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
DECLARE
	"resolved_principal_id" uuid;
BEGIN
	IF "target_user_id" IS NULL THEN
		RETURN NULL;
	END IF;

	SELECT principal."id" INTO "resolved_principal_id"
	FROM "public"."memberships" AS member
	JOIN "public"."workspace_principals" AS principal
		ON principal."workspace_id" = member."workspace_id"
		AND principal."membership_id" = member."id"
	WHERE member."workspace_id" = "target_workspace_id"
		AND member."user_id" = "target_user_id";

	IF "resolved_principal_id" IS NOT NULL THEN
		RETURN "resolved_principal_id";
	END IF;

	INSERT INTO "public"."workspace_principals" ("workspace_id", "kind", "membership_id", "activated_at")
	SELECT member."workspace_id", 'membership', member."id", member."created_at"
	FROM "public"."memberships" AS member
	WHERE member."workspace_id" = "target_workspace_id"
		AND member."user_id" = "target_user_id"
	ON CONFLICT ("workspace_id", "membership_id") DO NOTHING;

	SELECT principal."id" INTO "resolved_principal_id"
	FROM "public"."memberships" AS member
	JOIN "public"."workspace_principals" AS principal
		ON principal."workspace_id" = member."workspace_id"
		AND principal."membership_id" = member."id"
	WHERE member."workspace_id" = "target_workspace_id"
		AND member."user_id" = "target_user_id";

	RETURN "resolved_principal_id";
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_owner_from_creator"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."owner_principal_id" IS NULL THEN
		NEW."owner_principal_id" := "public"."rf101_compat_membership_principal_id"(
			NEW."workspace_id", NEW."created_by"
		);
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_session_owner"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."owner_principal_id" IS NULL THEN
		NEW."owner_principal_id" := "public"."rf101_compat_membership_principal_id"(
			NEW."workspace_id", NEW."user_id"
		);
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_share_publisher"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."publisher_principal_id" IS NULL THEN
		NEW."publisher_principal_id" := "public"."rf101_compat_membership_principal_id"(
			NEW."workspace_id", NEW."created_by"
		);
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_audit_actor"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."actor_principal_id" IS NULL THEN
		NEW."actor_principal_id" := "public"."rf101_compat_membership_principal_id"(
			NEW."workspace_id", NEW."actor_user_id"
		);
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint

CREATE TRIGGER "agents_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."agents"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_owner_from_creator"();--> statement-breakpoint
CREATE TRIGGER "files_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."files"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_owner_from_creator"();--> statement-breakpoint
CREATE TRIGGER "skills_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."skills"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_owner_from_creator"();--> statement-breakpoint
CREATE TRIGGER "mcp_servers_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."mcp_servers"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_owner_from_creator"();--> statement-breakpoint
CREATE TRIGGER "projects_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."projects"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_owner_from_creator"();--> statement-breakpoint
CREATE TRIGGER "sessions_rf101_compat_owner" BEFORE INSERT OR UPDATE OF "user_id" ON "public"."sessions"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_session_owner"();--> statement-breakpoint
CREATE TRIGGER "shares_rf101_compat_publisher" BEFORE INSERT OR UPDATE OF "created_by" ON "public"."shares"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_share_publisher"();--> statement-breakpoint
CREATE TRIGGER "audit_events_rf101_compat_actor" BEFORE INSERT OR UPDATE OF "actor_user_id" ON "public"."audit_events"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_audit_actor"();--> statement-breakpoint

-- A prior-version writer can also create a Membership or API key without its new principal row.
-- Deferred source triggers let a current writer insert its chosen principal in the same
-- transaction; otherwise they create the exact source principal at commit.
CREATE FUNCTION "public"."rf101_compat_ensure_membership_principal"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	INSERT INTO "public"."workspace_principals" ("workspace_id", "kind", "membership_id", "activated_at")
	VALUES (NEW."workspace_id", 'membership', NEW."id", NEW."created_at")
	ON CONFLICT ("workspace_id", "membership_id") DO NOTHING;
	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_ensure_api_key_principal"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	INSERT INTO "public"."workspace_principals" (
		"workspace_id", "kind", "api_key_id", "activated_at", "revoked_at"
	)
	VALUES (NEW."workspace_id", 'api_key', NEW."id", NEW."created_at", NEW."revoked_at")
	ON CONFLICT ("workspace_id", "api_key_id") DO NOTHING;
	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE FUNCTION "public"."rf101_compat_sync_api_key_revocation"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	UPDATE "public"."workspace_principals"
	SET "revoked_at" = NEW."revoked_at"
	WHERE "workspace_id" = NEW."workspace_id" AND "api_key_id" = NEW."id";
	RETURN NULL;
END
$$;--> statement-breakpoint

CREATE CONSTRAINT TRIGGER "memberships_rf101_compat_principal"
AFTER INSERT ON "public"."memberships" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_ensure_membership_principal"();--> statement-breakpoint
CREATE CONSTRAINT TRIGGER "api_keys_rf101_compat_principal"
AFTER INSERT ON "public"."api_keys" DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_ensure_api_key_principal"();--> statement-breakpoint
CREATE TRIGGER "api_keys_rf101_compat_revocation"
AFTER UPDATE OF "revoked_at" ON "public"."api_keys"
FOR EACH ROW EXECUTE FUNCTION "public"."rf101_compat_sync_api_key_revocation"();--> statement-breakpoint

-- Projects historically had only a users(id) creator FK. Refuse anomalous data rather than
-- guessing another person or silently creating an unapproved workspace-system principal.
DO $$
BEGIN
	IF EXISTS (
		SELECT 1
		FROM "projects" AS project
		LEFT JOIN "memberships" AS member
			ON member."workspace_id" = project."workspace_id"
			AND member."user_id" = project."created_by"
		WHERE member."id" IS NULL
	) THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'RF-101 cannot map one or more project creators to a same-workspace membership';
	END IF;
END
$$;--> statement-breakpoint

UPDATE "agents" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
UPDATE "files" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
UPDATE "skills" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
UPDATE "mcp_servers" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
UPDATE "projects" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
UPDATE "sessions" AS owned SET "owner_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."user_id";--> statement-breakpoint
UPDATE "shares" AS owned SET "publisher_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = owned."workspace_id" AND member."user_id" = owned."created_by";--> statement-breakpoint
-- Actor attribution is nullable by design. Only an exact surviving same-workspace membership is
-- backfilled; actor_label remains the historical record when the user or membership is gone.
UPDATE "audit_events" AS event SET "actor_principal_id" = principal."id"
FROM "memberships" AS member JOIN "workspace_principals" AS principal
	ON principal."workspace_id" = member."workspace_id" AND principal."membership_id" = member."id"
WHERE member."workspace_id" = event."workspace_id" AND member."user_id" = event."actor_user_id";--> statement-breakpoint

DO $$
BEGIN
	IF EXISTS (SELECT 1 FROM "agents" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "files" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "skills" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "mcp_servers" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "projects" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "sessions" WHERE "owner_principal_id" IS NULL)
		OR EXISTS (SELECT 1 FROM "shares" WHERE "publisher_principal_id" IS NULL)
	THEN
		RAISE EXCEPTION USING
			ERRCODE = '23514',
			MESSAGE = 'RF-101 principal ownership backfill left one or more required rows unmapped';
	END IF;
END
$$;--> statement-breakpoint

-- Required ownership must be complete before constraints are installed. SET NOT NULL is safe in
-- this drained transactional cutover only after the exact backfill above has mapped every row.
ALTER TABLE "agents" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "publisher_principal_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "owner_principal_id" SET NOT NULL;--> statement-breakpoint

CREATE INDEX "workspace_principals_workspace_revoked_idx" ON "workspace_principals" USING btree ("workspace_id","revoked_at");--> statement-breakpoint
CREATE INDEX "agents_owner_principal_idx" ON "agents" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "audit_events_actor_principal_idx" ON "audit_events" USING btree ("actor_principal_id");--> statement-breakpoint
CREATE INDEX "files_workspace_owner_principal_idx" ON "files" USING btree ("workspace_id","owner_principal_id");--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_principal_idx" ON "mcp_servers" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "projects_owner_principal_idx" ON "projects" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "sessions_owner_principal_idx" ON "sessions" USING btree ("owner_principal_id");--> statement-breakpoint
CREATE INDEX "shares_publisher_principal_idx" ON "shares" USING btree ("publisher_principal_id");--> statement-breakpoint
CREATE INDEX "skills_owner_principal_idx" ON "skills" USING btree ("owner_principal_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Preserve immutable audit tenant/label history when a source principal disappears. PostgreSQL's
-- column-list SET NULL clears only the nullable actor id; workspace_id remains required and intact.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_principal_workspace_fk" FOREIGN KEY ("workspace_id","actor_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE SET NULL ("actor_principal_id") ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shares" ADD CONSTRAINT "shares_publisher_principal_workspace_fk" FOREIGN KEY ("workspace_id","publisher_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_owner_principal_workspace_fk" FOREIGN KEY ("workspace_id","owner_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;
