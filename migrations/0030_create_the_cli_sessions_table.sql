CREATE TABLE "cli_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"user_code" text NOT NULL,
	"status" text NOT NULL,
	"approval_expires_at" timestamp with time zone NOT NULL,
	"token_hash" text,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "cli_sessions_status_valid" CHECK ("cli_sessions"."status" in ('approved', 'denied', 'active', 'revoked')),
	CONSTRAINT "cli_sessions_user_code_shape" CHECK ("cli_sessions"."user_code" ~ '^[A-Z]{8}$'),
	CONSTRAINT "cli_sessions_token_iff_issued" CHECK (("cli_sessions"."status" in ('active', 'revoked')) = ("cli_sessions"."token_hash" is not null and "cli_sessions"."expires_at" is not null)),
	CONSTRAINT "cli_sessions_revoked_iff_status" CHECK (("cli_sessions"."status" = 'revoked') = ("cli_sessions"."revoked_at" is not null)),
	CONSTRAINT "cli_sessions_expiry_after_created" CHECK ("cli_sessions"."expires_at" is null or "cli_sessions"."expires_at" > "cli_sessions"."created_at")
);
--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cli_sessions" ADD CONSTRAINT "cli_sessions_member_workspace_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_user_code_key" ON "cli_sessions" USING btree ("user_code");--> statement-breakpoint
CREATE UNIQUE INDEX "cli_sessions_token_hash_key" ON "cli_sessions" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "cli_sessions_workspace_user_idx" ON "cli_sessions" USING btree ("workspace_id","user_id");