-- safe: the allowed set only widens by 'vertex'; every existing row still satisfies it, so no row is narrowed or rejected
ALTER TABLE "model_connections" DROP CONSTRAINT "model_connections_provider_valid";--> statement-breakpoint
-- safe: the allowed set only widens by 'vertex'; every existing row still satisfies it, so no row is narrowed or rejected
ALTER TABLE "runs" DROP CONSTRAINT "runs_provider_valid";--> statement-breakpoint
-- safe: the allowed set only widens by 'vertex'; every existing row still satisfies it, so no row is narrowed or rejected
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_provider_valid" CHECK ("model_connections"."provider" in ('anthropic', 'anthropic-compatible', 'openai', 'azure-openai', 'openai-compatible', 'vertex'));--> statement-breakpoint
-- safe: the allowed set only widens by 'vertex'; every existing row still satisfies it, so no row is narrowed or rejected
ALTER TABLE "runs" ADD CONSTRAINT "runs_provider_valid" CHECK ("runs"."provider" in ('anthropic', 'anthropic-compatible', 'openai', 'azure-openai', 'openai-compatible', 'vertex'));