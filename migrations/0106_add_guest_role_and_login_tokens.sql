CREATE TABLE "login_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"email_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "login_tokens_token_hash_shape" CHECK ("login_tokens"."token_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "login_tokens_email_hash_shape" CHECK ("login_tokens"."email_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "login_tokens_expires_after_created" CHECK ("login_tokens"."expires_at" > "login_tokens"."created_at"),
	CONSTRAINT "login_tokens_used_after_created" CHECK ("login_tokens"."used_at" is null or "login_tokens"."used_at" >= "login_tokens"."created_at")
);
--> statement-breakpoint
-- safe: re-added at the end of this file, widened with 'guest'; no row is narrowed
ALTER TABLE "memberships" DROP CONSTRAINT "memberships_role_valid";--> statement-breakpoint
CREATE UNIQUE INDEX "login_tokens_token_hash_key" ON "login_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "login_tokens_email_created_idx" ON "login_tokens" USING btree ("email_hash","created_at");--> statement-breakpoint
-- safe: the check is only widened with 'guest'; every existing row already passes it
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_role_valid" CHECK ("memberships"."role" in ('owner', 'admin', 'builder', 'viewer', 'guest'));