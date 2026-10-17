-- PR #403 review (issue #393): first-run setup marks the agent it configured and tested, so the
-- composer selects that agent before the user chooses one. Recorded on the agent, not as an id on
-- `workspaces`, so no reference points back into `agents` and a deleted agent takes its mark with it.
-- Additive and nullable; no revision from the previous release reads or writes it, so no
-- single-revision cutover is needed (ADR-0069). Numbered 0032 so the file prefix equals the journal
-- idx (32).
ALTER TABLE "agents" ADD COLUMN "setup_configured_at" timestamp with time zone;