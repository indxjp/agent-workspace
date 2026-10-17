CREATE TABLE "session_state_blobs" (
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"blob_key" text NOT NULL,
	"storage_key" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_state_blobs_pkey" PRIMARY KEY("workspace_id","session_id","engine","blob_key"),
	CONSTRAINT "session_state_blobs_engine_valid" CHECK ("session_state_blobs"."engine" in ('claude-agent-sdk'))
);
--> statement-breakpoint
CREATE TABLE "session_state_entries" (
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"stream_key" text NOT NULL,
	"sequence" bigint NOT NULL,
	"entry_key" text,
	"entry" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_state_entries_pkey" PRIMARY KEY("workspace_id","session_id","engine","stream_key","sequence"),
	CONSTRAINT "session_state_entries_engine_valid" CHECK ("session_state_entries"."engine" in ('claude-agent-sdk'))
);
--> statement-breakpoint
CREATE TABLE "session_state_streams" (
	"workspace_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"engine" text NOT NULL,
	"stream_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_state_streams_pkey" PRIMARY KEY("workspace_id","session_id","engine","stream_key"),
	CONSTRAINT "session_state_streams_engine_valid" CHECK ("session_state_streams"."engine" in ('claude-agent-sdk'))
);
--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD CONSTRAINT "session_state_blobs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state_blobs" ADD CONSTRAINT "session_state_blobs_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state_entries" ADD CONSTRAINT "session_state_entries_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state_entries" ADD CONSTRAINT "session_state_entries_stream_fk" FOREIGN KEY ("workspace_id","session_id","engine","stream_key") REFERENCES "public"."session_state_streams"("workspace_id","session_id","engine","stream_key") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state_streams" ADD CONSTRAINT "session_state_streams_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_state_streams" ADD CONSTRAINT "session_state_streams_session_workspace_fk" FOREIGN KEY ("session_id","workspace_id") REFERENCES "public"."sessions"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "session_state_blobs_workspace_updated_idx" ON "session_state_blobs" USING btree ("workspace_id","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "session_state_entries_key_unique" ON "session_state_entries" USING btree ("workspace_id","session_id","engine","stream_key","entry_key");--> statement-breakpoint
CREATE INDEX "session_state_streams_workspace_updated_idx" ON "session_state_streams" USING btree ("workspace_id","updated_at");