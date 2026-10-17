CREATE TABLE "agents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"instructions" text NOT NULL,
	"model_connection_id" uuid,
	"model" text,
	"permissions" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agents_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "agents_name_not_blank" CHECK (length(btrim("agents"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_workspace_user_key" UNIQUE("workspace_id","user_id"),
	CONSTRAINT "memberships_role_valid" CHECK ("memberships"."role" in ('owner', 'admin', 'builder', 'viewer'))
);
--> statement-breakpoint
CREATE TABLE "model_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "model_connections_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "model_connections_provider_valid" CHECK ("model_connections"."provider" in ('anthropic', 'anthropic-compatible', 'openai', 'azure-openai', 'openai-compatible'))
);
--> statement-breakpoint
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"model" text,
	"provider" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cost_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"tool_calls" integer DEFAULT 0 NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "runs_status_valid" CHECK ("runs"."status" in ('queued', 'running', 'completed', 'failed', 'cancelled')),
	CONSTRAINT "runs_provider_valid" CHECK ("runs"."provider" in ('anthropic', 'anthropic-compatible', 'openai', 'azure-openai', 'openai-compatible')),
	CONSTRAINT "runs_ended_at_iff_terminal" CHECK (("runs"."status" in ('completed', 'failed', 'cancelled')) = ("runs"."ended_at" is not null)),
	CONSTRAINT "runs_ended_after_started" CHECK ("runs"."ended_at" is null or "runs"."started_at" is null or "runs"."ended_at" >= "runs"."started_at"),
	CONSTRAINT "runs_counters_non_negative" CHECK ("runs"."input_tokens" >= 0 and "runs"."output_tokens" >= 0 and "runs"."tool_calls" >= 0 and "runs"."cost_usd" >= 0)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"claude_session_id" text,
	"title" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "sessions_status_valid" CHECK ("sessions"."status" in ('active', 'archived'))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_lowercase" CHECK ("users"."email" = lower("users"."email")),
	CONSTRAINT "users_email_shape" CHECK ("users"."email" ~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'),
	CONSTRAINT "users_name_not_blank" CHECK (length(btrim("users"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "workspaces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workspaces_slug_format" CHECK ("workspaces"."slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'),
	CONSTRAINT "workspaces_name_not_blank" CHECK (length(btrim("workspaces"."name")) > 0)
);
--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_connection_id_model_connections_id_fk" FOREIGN KEY ("model_connection_id") REFERENCES "public"."model_connections"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_model_connection_workspace_fk" FOREIGN KEY ("model_connection_id","workspace_id") REFERENCES "public"."model_connections"("id","workspace_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_connections" ADD CONSTRAINT "model_connections_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_member_workspace_fk" FOREIGN KEY ("workspace_id","user_id") REFERENCES "public"."memberships"("workspace_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_workspace_name_key" ON "agents" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "agents_model_connection_idx" ON "agents" USING btree ("model_connection_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_connections_workspace_name_key" ON "model_connections" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "runs_workspace_created_idx" ON "runs" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "runs_session_created_idx" ON "runs" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_workspace_updated_idx" ON "sessions" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_workspace_claude_session_key" ON "sessions" USING btree ("workspace_id","claude_session_id");--> statement-breakpoint
CREATE INDEX "sessions_agent_idx" ON "sessions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "workspaces_slug_key" ON "workspaces" USING btree ("slug");