CREATE TABLE "agent_grants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_grants_workspace_agent_user_key" UNIQUE("workspace_id","agent_id","user_id")
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "files" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "skills" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_grants" ADD CONSTRAINT "agent_grants_member_workspace_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_grants_agent_idx" ON "agent_grants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_grants_user_idx" ON "agent_grants" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_workspace_fk" FOREIGN KEY ("workspace_id","created_by") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Backfill (docs/adr/W9-AUTH-117-ownership-columns-and-backfill.md): every existing row is
-- attributed to its workspace's oldest Owner membership, falling back to that workspace's oldest
-- membership of any role only if it somehow has no Owner. An explicit, documented owner — never
-- NULL, and never a guess finer-grained than "the workspace's own longest-standing member".
UPDATE "agents" AS t
SET "created_by" = owner.user_id
FROM (
	SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
	FROM "memberships" m
	ORDER BY m.workspace_id, (m.role = 'owner') DESC, m.created_at ASC, m.id ASC
) AS owner
WHERE t.workspace_id = owner.workspace_id AND t."created_by" IS NULL;
--> statement-breakpoint
UPDATE "files" AS t
SET "created_by" = owner.user_id
FROM (
	SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
	FROM "memberships" m
	ORDER BY m.workspace_id, (m.role = 'owner') DESC, m.created_at ASC, m.id ASC
) AS owner
WHERE t.workspace_id = owner.workspace_id AND t."created_by" IS NULL;
--> statement-breakpoint
UPDATE "mcp_servers" AS t
SET "created_by" = owner.user_id
FROM (
	SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
	FROM "memberships" m
	ORDER BY m.workspace_id, (m.role = 'owner') DESC, m.created_at ASC, m.id ASC
) AS owner
WHERE t.workspace_id = owner.workspace_id AND t."created_by" IS NULL;
--> statement-breakpoint
UPDATE "skills" AS t
SET "created_by" = owner.user_id
FROM (
	SELECT DISTINCT ON (m.workspace_id) m.workspace_id, m.user_id
	FROM "memberships" m
	ORDER BY m.workspace_id, (m.role = 'owner') DESC, m.created_at ASC, m.id ASC
) AS owner
WHERE t.workspace_id = owner.workspace_id AND t."created_by" IS NULL;
--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "files" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "created_by" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ALTER COLUMN "created_by" SET NOT NULL;
