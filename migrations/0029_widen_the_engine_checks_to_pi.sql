-- ENG-08 (#307, ADR-0081): `pi` joins `claude-agent-sdk` and `openai-agents` in every engine CHECK.
-- Additive: each constraint is widened, never narrowed, and a revision from the previous release
-- only ever writes `claude-agent-sdk` or `openai-agents`, which both the old and the new constraint
-- admit — so no single-revision cutover is needed (ADR-0069's rule applies to incompatible changes).
ALTER TABLE "runs" DROP CONSTRAINT "runs_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_blobs" DROP CONSTRAINT "session_state_blobs_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_entries" DROP CONSTRAINT "session_state_entries_engine_valid";--> statement-breakpoint
ALTER TABLE "session_state_streams" DROP CONSTRAINT "session_state_streams_engine_valid";--> statement-breakpoint
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_engine_valid";--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_engine_valid" CHECK ("runs"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi'));--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD CONSTRAINT "session_state_blobs_engine_valid" CHECK ("session_state_blobs"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi'));--> statement-breakpoint
ALTER TABLE "session_state_entries" ADD CONSTRAINT "session_state_entries_engine_valid" CHECK ("session_state_entries"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi'));--> statement-breakpoint
ALTER TABLE "session_state_streams" ADD CONSTRAINT "session_state_streams_engine_valid" CHECK ("session_state_streams"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi'));--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_engine_valid" CHECK ("sessions"."engine" in ('claude-agent-sdk', 'openai-agents', 'pi'));