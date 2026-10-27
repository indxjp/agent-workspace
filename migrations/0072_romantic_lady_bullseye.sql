-- STO-313 (#1668, the storage design, §04): a session-state blob gets an object ID and a status, as
-- a catalog row did in 0070. Expand only: existing rows keep `object_id` NULL (their bytes stay at
-- `storage_key`) and are `ready`. The primary key stays the `ON CONFLICT` arbiter of every writer.
-- Hand edit: the CHECK below is added `NOT VALID` and validated in this migration; restore both
-- statements after any regeneration (ADR-0069).
ALTER TABLE "session_state_blobs" ADD COLUMN "object_id" uuid;--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD CONSTRAINT "session_state_blobs_status_valid" CHECK ("session_state_blobs"."status" in ('pending', 'ready', 'deleting')) NOT VALID;--> statement-breakpoint
ALTER TABLE "session_state_blobs" VALIDATE CONSTRAINT "session_state_blobs_status_valid";
