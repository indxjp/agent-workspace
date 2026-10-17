-- Issue #538 (S2-05b, C18, ADR-0105): the resume key of a hosted surface session.
-- `surface_session_keys` holds one row per session a surface bootstrap opened: the SHA-256 digest
-- of the key (never the key), and the surface name and agent it was issued for, so a reloaded page
-- resumes exactly that (surface, agent) session. Both references are tenant-paired and cascade.
-- Additive: one new table, its constraints and one index. No revision from the previous release
-- reads or writes it, so no single-revision cutover is needed (ADR-0069). Numbered 0037 so the
-- file prefix equals the journal idx (37).
CREATE TABLE "surface_session_keys" (
	"session_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"surface_name" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "surface_session_keys" ADD CONSTRAINT "surface_session_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_session_keys" ADD CONSTRAINT "surface_session_keys_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "surface_session_keys" ADD CONSTRAINT "surface_session_keys_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "surface_session_keys_workspace_idx" ON "surface_session_keys" USING btree ("workspace_id");