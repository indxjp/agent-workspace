CREATE TABLE "browser_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"minted_by_principal_id" uuid NOT NULL,
	"scope_kind" text NOT NULL,
	"run_id" uuid,
	"session_id" uuid,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "browser_tokens_scope_kind_valid" CHECK ("browser_tokens"."scope_kind" in ('run', 'session')),
	CONSTRAINT "browser_tokens_scope_xor" CHECK (("browser_tokens"."scope_kind" = 'run' and "browser_tokens"."run_id" is not null and "browser_tokens"."session_id" is null)
        or ("browser_tokens"."scope_kind" = 'session' and "browser_tokens"."session_id" is not null and "browser_tokens"."run_id" is null)),
	CONSTRAINT "browser_tokens_expiry_after_created" CHECK ("browser_tokens"."expires_at" > "browser_tokens"."created_at"),
	CONSTRAINT "browser_tokens_revoked_after_created" CHECK ("browser_tokens"."revoked_at" is null or "browser_tokens"."revoked_at" >= "browser_tokens"."created_at")
);
--> statement-breakpoint
ALTER TABLE "browser_tokens" ADD CONSTRAINT "browser_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tokens" ADD CONSTRAINT "browser_tokens_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tokens" ADD CONSTRAINT "browser_tokens_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "browser_tokens" ADD CONSTRAINT "browser_tokens_minter_workspace_fk" FOREIGN KEY ("workspace_id","minted_by_principal_id") REFERENCES "public"."workspace_principals"("workspace_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "browser_tokens_hash_key" ON "browser_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "browser_tokens_workspace_run_idx" ON "browser_tokens" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "browser_tokens_workspace_session_idx" ON "browser_tokens" USING btree ("workspace_id","session_id");--> statement-breakpoint
CREATE INDEX "browser_tokens_active_idx" ON "browser_tokens" USING btree ("workspace_id","revoked_at","expires_at");