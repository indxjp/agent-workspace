-- #1845 slice 4b: a call to a tool that does not exist is journaled with a NULL `tool`. Expand only:
-- no row changes, and an older writer that always sets `tool` keeps working.
-- safe: `builder_tool_calls_tool_valid` stays as it is, because a NULL passes a CHECK; no row is narrowed
ALTER TABLE "builder_tool_calls" ALTER COLUMN "tool" DROP NOT NULL;
