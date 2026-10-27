-- safe: re-added in the next statement, widened with 'builder'; no row is narrowed
ALTER TABLE "endpoint_clients" DROP CONSTRAINT "endpoint_clients_kind_valid";--> statement-breakpoint
ALTER TABLE "endpoint_clients" ADD CONSTRAINT "endpoint_clients_kind_valid" CHECK ("endpoint_clients"."kind" in ('mcp-project', 'a2a-agent', 'builder'));