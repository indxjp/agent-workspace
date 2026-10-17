-- Issue #527 (S2-02b, ADR-0113 C15/C16): connector kinds and the run tool snapshot.
-- `mcp_servers` gains `kind` ('mcp', 'openapi' or 'postgres'; default 'mcp') and `tool_config`, a
-- JSON object a tool connector carries instead of a transport, command, args or URL. `runs` gains
-- `tool_connector_ids`, the sorted, distinct set of tool connectors a run may call, snapshotted
-- before launch (C16); it has no foreign key because PostgreSQL cannot put one on an array element,
-- and the gateway re-checks tenancy, kind and existence on every call. There is no secret-by-name
-- column (SD3): a tool connector's credential stays a reference by id into `secrets`.
-- Additive except two things: `transport` drops NOT NULL (a tool row has none), and the four
-- transport and credential checks are dropped and re-added under the same names, guarded by
-- `kind <> 'mcp' or (...)` so they mean exactly what they meant for every MCP row. Every existing
-- row becomes kind 'mcp' with tool_config NULL, and every constraint is added VALID, so applying
-- this migration proves that the existing rows satisfy the new checks. A revision from the previous
-- release inserts without `kind` and gets 'mcp', and reads neither new column, so no
-- single-revision cutover is needed (ADR-0069); tool rows cannot exist until S2-02c ships. The
-- openapi auth/credential pairing lives in tool_config and is enforced by the server and the
-- resource schema, not here. Numbered 0036 so the file prefix equals the journal idx (36).
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_stdio_has_command";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_remote_has_url";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_args_are_stdio_only";--> statement-breakpoint
ALTER TABLE "mcp_servers" DROP CONSTRAINT "mcp_servers_credential_required";--> statement-breakpoint
ALTER TABLE "mcp_servers" ALTER COLUMN "transport" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "kind" text DEFAULT 'mcp' NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD COLUMN "tool_config" jsonb;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "tool_connector_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_kind_valid" CHECK ("mcp_servers"."kind" in ('mcp', 'openapi', 'postgres'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_transport_by_kind" CHECK (("mcp_servers"."kind" = 'mcp') = ("mcp_servers"."transport" is not null));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tool_kind_fields" CHECK ("mcp_servers"."kind" = 'mcp' or ("mcp_servers"."command" is null and "mcp_servers"."args" is null and "mcp_servers"."url" is null));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tool_config_by_kind" CHECK (("mcp_servers"."kind" = 'mcp') = ("mcp_servers"."tool_config" is null));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tool_config_is_object" CHECK ("mcp_servers"."tool_config" is null or jsonb_typeof("mcp_servers"."tool_config") = 'object');--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_tool_credential" CHECK ("mcp_servers"."kind" = 'mcp' or ("mcp_servers"."auth_type" = 'none' and ("mcp_servers"."kind" <> 'postgres' or "mcp_servers"."credential_secret_id" is not null)));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_stdio_has_command" CHECK ("mcp_servers"."kind" <> 'mcp' or (("mcp_servers"."transport" = 'stdio') = ("mcp_servers"."command" is not null)));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_remote_has_url" CHECK ("mcp_servers"."kind" <> 'mcp' or (("mcp_servers"."transport" in ('http', 'sse')) = ("mcp_servers"."url" is not null)));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_args_are_stdio_only" CHECK ("mcp_servers"."kind" <> 'mcp' or ("mcp_servers"."args" is null or "mcp_servers"."transport" = 'stdio'));--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_required" CHECK ("mcp_servers"."kind" <> 'mcp' or (("mcp_servers"."auth_type" in ('api-key', 'bearer', 'oauth')) = ("mcp_servers"."credential_secret_id" is not null)));