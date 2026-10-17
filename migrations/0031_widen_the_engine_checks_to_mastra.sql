-- ENG-10 (#309, ADR-0084): `mastra` joins `claude-agent-sdk`, `openai-agents` and `pi` in every engine
-- CHECK. Additive: each constraint is widened, never narrowed, and a revision from the previous release
-- only ever writes one of the three earlier ids, which both the old and the new constraint admit — so
-- no single-revision cutover is needed (ADR-0069's rule applies to incompatible changes). Numbered
-- 0031 so the file prefix equals the journal `idx` (31): `drizzle-kit generate` names the next
-- migration `lastEntry.idx + 1`, so a gap would make it reuse this prefix and overwrite
-- `meta/0032_snapshot.json`. It follows 0030 (`cli_sessions`, #356, ADR-0083), which merged first.
ALTER TABLE "runs" DROP CONSTRAINT "runs_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_blobs" DROP CONSTRAINT "session_state_blobs_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_entries" DROP CONSTRAINT "session_state_entries_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_streams" DROP CONSTRAINT "session_state_streams_engine_valid";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_engine_valid";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_engine_valid" CHECK ("runs"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi', 'mastra'));--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD CONSTRAINT "session_state_blobs_engine_valid" CHECK ("session_state_blobs"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi', 'mastra'));--> statement-breakpoint
ALTER TABLE "session_state_entries" ADD CONSTRAINT "session_state_entries_engine_valid" CHECK ("session_state_entries"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi', 'mastra'));--> statement-breakpoint
ALTER TABLE "session_state_streams" ADD CONSTRAINT "session_state_streams_engine_valid" CHECK ("session_state_streams"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi', 'mastra'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_engine_valid" CHECK ("sessions"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi', 'mastra'));