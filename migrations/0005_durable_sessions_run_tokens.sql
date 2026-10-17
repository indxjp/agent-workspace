CREATE TABLE "run_tokens" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid NOT NULL,
	"workspace_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "run_tokens_expiry_after_created" CHECK ("run_tokens"."expires_at" > "run_tokens"."created_at"),
	CONSTRAINT "run_tokens_revoked_after_created" CHECK ("run_tokens"."revoked_at" is null or "run_tokens"."revoked_at" >= "run_tokens"."created_at")
);
--> statement-breakpoint
CREATE TABLE "session_messages" (
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"session_id" uuid NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"sequence" bigint NOT NULL,
	"position" bigint NOT NULL,
	"entry_uuid" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_messages_pkey" PRIMARY KEY("workspace_id","project_key","session_id","subpath","sequence")
);
--> statement-breakpoint
CREATE TABLE "session_transcripts" (
	"workspace_id" uuid NOT NULL,
	"project_key" text NOT NULL,
	"session_id" uuid NOT NULL,
	"subpath" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_transcripts_pkey" PRIMARY KEY("workspace_id","project_key","session_id","subpath")
);
--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "run_tokens" ADD CONSTRAINT "run_tokens_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_messages" ADD CONSTRAINT "session_messages_transcript_fk" FOREIGN KEY ("workspace_id","project_key","session_id","subpath") REFERENCES "public"."session_transcripts"("workspace_id","project_key","session_id","subpath") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_transcripts" ADD CONSTRAINT "session_transcripts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "run_tokens_hash_key" ON "run_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "run_tokens_workspace_run_idx" ON "run_tokens" USING btree ("workspace_id","run_id");--> statement-breakpoint
CREATE INDEX "run_tokens_active_idx" ON "run_tokens" USING btree ("workspace_id","run_id","revoked_at","expires_at");--> statement-breakpoint
CREATE INDEX "session_messages_key_sequence_idx" ON "session_messages" USING btree ("workspace_id","project_key","session_id","subpath","sequence");--> statement-breakpoint
CREATE INDEX "session_messages_key_uuid_idx" ON "session_messages" USING btree ("workspace_id","project_key","session_id","subpath","entry_uuid","sequence");--> statement-breakpoint
CREATE INDEX "session_transcripts_workspace_updated_idx" ON "session_transcripts" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE INDEX "session_transcripts_project_updated_idx" ON "session_transcripts" USING btree ("project_key","updated_at");