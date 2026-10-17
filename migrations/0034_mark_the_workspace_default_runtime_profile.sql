-- Issue #504 (S1-22): a workspace may mark one runtime profile as its default. An agent version
-- that names no runtime profile (`runtimeProfileName: null`) resolves to it when the version is
-- applied, so the stored agent row carries a concrete profile id and run preflight stays strict.
-- The mark lives on `runtime_profiles` rather than as an id on `workspaces`, so the tenant root
-- gains no reference back into a tenant table (no second schema cycle), a workspace can never
-- default to another workspace's profile, and deleting the profile removes the default with it.
-- `workspace_default` is `true` or NULL, never `false`, so the plain unique key on
-- (workspace_id, workspace_default) allows at most one default per workspace.
-- Additive and nullable, with no backfill: every existing profile stays unmarked, which means "no
-- default" (agents that name no profile stay refused, as before). No revision from the previous
-- release reads or writes it, so no single-revision cutover is needed (ADR-0069). Numbered 0034 so
-- the file prefix equals the journal idx (34).
ALTER TABLE "runtime_profiles" ADD COLUMN "workspace_default" boolean;--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_workspace_default_key" UNIQUE("workspace_id","workspace_default");--> statement-breakpoint
ALTER TABLE "runtime_profiles" ADD CONSTRAINT "runtime_profiles_workspace_default_true_or_null" CHECK ("runtime_profiles"."workspace_default" is null or "runtime_profiles"."workspace_default");