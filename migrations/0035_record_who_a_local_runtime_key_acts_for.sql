-- Issue #509 (S1-24): an API-key principal may record the membership principal it acts for. The
-- per-run local runtime key `aw dev` mints (ADR-0109, S1-21) acts for the bootstrap admin who
-- issued it, so what that key writes (agents, sessions, skills, files, MCP servers, projects and
-- shares) is owned by that admin rather than by a key the next start sweeps or that expires after
-- 12 h. Audit, version and browser-token attribution keep the acting key.
-- The column lives on `workspace_principals` rather than on `api_keys`: a reference from
-- `api_keys` to this table would close a schema cycle, while a self-reference is none. The pair
-- FK is tenant-paired and NO ACTION, like every owner FK, so a membership principal a key acted
-- for cannot be deleted while that key principal remains. The two checks keep the column on
-- API-key principals only and never pointing at the principal itself.
-- Additive and nullable, with no backfill: every existing principal stays unset, which means "owns
-- what it writes" (today's semantics; hosted keys never set it). The local start's repair step
-- fills it for earlier local runtime keys. No revision from the previous release reads or writes
-- it, so no single-revision cutover is needed (ADR-0069). Numbered 0035 so the file prefix equals
-- the journal idx (35).
ALTER TABLE "workspace_principals" ADD COLUMN "acts_for_principal_id" uuid;--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_acts_for_workspace_fk" FOREIGN KEY ("workspace_id","acts_for_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_acts_for_api_key_only" CHECK ("workspace_principals"."acts_for_principal_id" is null or "workspace_principals"."kind" = 'api_key');--> statement-breakpoint
ALTER TABLE "workspace_principals" ADD CONSTRAINT "workspace_principals_acts_for_not_self" CHECK ("workspace_principals"."acts_for_principal_id" is null or "workspace_principals"."acts_for_principal_id" <> "workspace_principals"."id");