CREATE TABLE "agent_files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"access" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_files_workspace_agent_file_key" UNIQUE("workspace_id","agent_id","file_id"),
	CONSTRAINT "agent_files_access_valid" CHECK ("agent_files"."access" in ('read', 'read-write'))
);
--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_mcp_servers_workspace_agent_server_key" UNIQUE("workspace_id","agent_id","mcp_server_id")
);
--> statement-breakpoint
CREATE TABLE "agent_skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"skill_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_skills_workspace_agent_skill_key" UNIQUE("workspace_id","agent_id","skill_id")
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_role_valid" CHECK ("api_keys"."role" in ('owner', 'admin', 'builder', 'viewer')),
	CONSTRAINT "api_keys_name_not_blank" CHECK (length(btrim("api_keys"."name")) > 0),
	CONSTRAINT "api_keys_key_prefix_not_blank" CHECK (length(btrim("api_keys"."key_prefix")) > 0),
	CONSTRAINT "api_keys_key_hash_not_blank" CHECK (length(btrim("api_keys"."key_hash")) > 0),
	CONSTRAINT "api_keys_expires_after_created" CHECK ("api_keys"."expires_at" is null or "api_keys"."expires_at" > "api_keys"."created_at"),
	CONSTRAINT "api_keys_revoked_after_created" CHECK ("api_keys"."revoked_at" is null or "api_keys"."revoked_at" >= "api_keys"."created_at")
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"actor_user_id" uuid,
	"actor_label" text NOT NULL,
	"action" text NOT NULL,
	"subject_id" text,
	"subject_label" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_events_action_valid" CHECK ("audit_events"."action" in ('user-created', 'user-deleted', 'agent-changed', 'provider-credential-changed', 'api-key-created', 'api-key-revoked', 'connector-changed', 'permission-changed', 'runtime-profile-changed', 'project-created', 'project-deleted', 'session-published', 'public-link-revoked', 'runnable-link-stopped', 'public-sharing-policy-changed')),
	CONSTRAINT "audit_events_actor_label_not_blank" CHECK (length(btrim("audit_events"."actor_label")) > 0),
	CONSTRAINT "audit_events_subject_label_not_blank" CHECK (length(btrim("audit_events"."subject_label")) > 0),
	CONSTRAINT "audit_events_subject_id_shape" CHECK ("audit_events"."subject_id" is null or "audit_events"."subject_id" ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$')
);
--> statement-breakpoint
CREATE TABLE "files" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"path" text NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"content_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "files_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "files_kind_valid" CHECK ("files"."kind" in ('file', 'folder')),
	CONSTRAINT "files_path_shape" CHECK ("files"."path" ~ '^[^/[:cntrl:]]+(/[^/[:cntrl:]]+)*$'),
	CONSTRAINT "files_path_no_dot_segments" CHECK ("files"."path" !~ '(^|/)[.][.]?(/|$)'),
	CONSTRAINT "files_storage_key_iff_file" CHECK (("files"."kind" = 'file') = ("files"."storage_key" is not null)),
	CONSTRAINT "files_storage_key_not_blank" CHECK ("files"."storage_key" is null or length(btrim("files"."storage_key")) > 0),
	CONSTRAINT "files_size_non_negative" CHECK ("files"."size_bytes" >= 0),
	CONSTRAINT "files_folder_has_no_content" CHECK ("files"."kind" <> 'folder' or ("files"."size_bytes" = 0 and "files"."content_type" is null))
);
--> statement-breakpoint
CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"transport" text NOT NULL,
	"command" text,
	"args" jsonb,
	"url" text,
	"auth_type" text DEFAULT 'none' NOT NULL,
	"credential_secret_id" uuid,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "mcp_servers_transport_valid" CHECK ("mcp_servers"."transport" in ('stdio', 'http', 'sse')),
	CONSTRAINT "mcp_servers_auth_type_valid" CHECK ("mcp_servers"."auth_type" in ('none', 'api-key', 'bearer', 'oauth')),
	CONSTRAINT "mcp_servers_stdio_has_command" CHECK (("mcp_servers"."transport" = 'stdio') = ("mcp_servers"."command" is not null)),
	CONSTRAINT "mcp_servers_remote_has_url" CHECK (("mcp_servers"."transport" in ('http', 'sse')) = ("mcp_servers"."url" is not null)),
	CONSTRAINT "mcp_servers_args_are_stdio_only" CHECK ("mcp_servers"."args" is null or "mcp_servers"."transport" = 'stdio'),
	CONSTRAINT "mcp_servers_command_not_blank" CHECK ("mcp_servers"."command" is null or length(btrim("mcp_servers"."command")) > 0),
	CONSTRAINT "mcp_servers_url_shape" CHECK ("mcp_servers"."url" is null or "mcp_servers"."url" ~ '^https?://'),
	CONSTRAINT "mcp_servers_credential_required" CHECK (("mcp_servers"."auth_type" in ('api-key', 'bearer', 'oauth')) = ("mcp_servers"."credential_secret_id" is not null)),
	CONSTRAINT "mcp_servers_name_not_blank" CHECK (length(btrim("mcp_servers"."name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"algorithm" text NOT NULL,
	"master_key_id" text NOT NULL,
	"wrapped_data_key" "bytea" NOT NULL,
	"wrapped_data_key_nonce" "bytea" NOT NULL,
	"wrapped_data_key_tag" "bytea" NOT NULL,
	"ciphertext" "bytea" NOT NULL,
	"ciphertext_nonce" "bytea" NOT NULL,
	"ciphertext_tag" "bytea" NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "secrets_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "secrets_name_shape" CHECK ("secrets"."name" ~ '^[A-Z][A-Z0-9_]{0,127}$'),
	CONSTRAINT "secrets_master_key_id_not_blank" CHECK (length(btrim("secrets"."master_key_id")) > 0),
	CONSTRAINT "secrets_algorithm_valid" CHECK ("secrets"."algorithm" in ('aes-256-gcm')),
	CONSTRAINT "secrets_wrapped_data_key_size" CHECK (octet_length("secrets"."wrapped_data_key") = 32),
	CONSTRAINT "secrets_nonce_sizes" CHECK (octet_length("secrets"."wrapped_data_key_nonce") = 12 and octet_length("secrets"."ciphertext_nonce") = 12),
	CONSTRAINT "secrets_tag_sizes" CHECK (octet_length("secrets"."wrapped_data_key_tag") = 16 and octet_length("secrets"."ciphertext_tag") = 16),
	CONSTRAINT "secrets_ciphertext_not_empty" CHECK (octet_length("secrets"."ciphertext") > 0)
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"name" text NOT NULL,
	"skill_md" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "skills_id_workspace_key" UNIQUE("id","workspace_id"),
	CONSTRAINT "skills_name_shape" CHECK ("skills"."name" ~ '^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$'),
	CONSTRAINT "skills_skill_md_not_blank" CHECK (length(btrim("skills"."skill_md")) > 0)
);
--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_files" ADD CONSTRAINT "agent_files_file_workspace_fk" FOREIGN KEY ("file_id","workspace_id") REFERENCES "public"."files"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_server_workspace_fk" FOREIGN KEY ("mcp_server_id","workspace_id") REFERENCES "public"."mcp_servers"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_agent_workspace_fk" FOREIGN KEY ("agent_id","workspace_id") REFERENCES "public"."agents"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_skills" ADD CONSTRAINT "agent_skills_skill_workspace_fk" FOREIGN KEY ("skill_id","workspace_id") REFERENCES "public"."skills"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "files" ADD CONSTRAINT "files_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_credential_secret_workspace_fk" FOREIGN KEY ("credential_secret_id","workspace_id") REFERENCES "public"."secrets"("id","workspace_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_files_file_idx" ON "agent_files" USING btree ("file_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_server_idx" ON "agent_mcp_servers" USING btree ("mcp_server_id");--> statement-breakpoint
CREATE INDEX "agent_skills_skill_idx" ON "agent_skills" USING btree ("skill_id");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_workspace_name_key" ON "api_keys" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_key_hash_key" ON "api_keys" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "api_keys_workspace_revoked_idx" ON "api_keys" USING btree ("workspace_id","revoked_at");--> statement-breakpoint
CREATE INDEX "audit_events_workspace_created_idx" ON "audit_events" USING btree ("workspace_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_actor_idx" ON "audit_events" USING btree ("actor_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "files_workspace_path_key" ON "files" USING btree ("workspace_id","path");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_workspace_name_key" ON "mcp_servers" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE INDEX "mcp_servers_credential_secret_idx" ON "mcp_servers" USING btree ("credential_secret_id");--> statement-breakpoint
CREATE UNIQUE INDEX "secrets_workspace_name_key" ON "secrets" USING btree ("workspace_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_workspace_name_key" ON "skills" USING btree ("workspace_id","name");