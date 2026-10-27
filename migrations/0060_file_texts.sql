CREATE TABLE "file_texts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"page" integer,
	"text" text NOT NULL,
	"tsv" "tsvector" NOT NULL,
	"source_size_bytes" bigint NOT NULL,
	"source_updated_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "file_texts_file_ordinal_key" UNIQUE("file_id","ordinal"),
	CONSTRAINT "file_texts_ordinal_non_negative" CHECK ("file_texts"."ordinal" >= 0),
	CONSTRAINT "file_texts_page_positive" CHECK ("file_texts"."page" is null or "file_texts"."page" >= 1),
	CONSTRAINT "file_texts_text_length" CHECK (char_length("file_texts"."text") <= 20000),
	CONSTRAINT "file_texts_source_size_non_negative" CHECK ("file_texts"."source_size_bytes" >= 0)
);
--> statement-breakpoint
ALTER TABLE "file_texts" ADD CONSTRAINT "file_texts_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_texts" ADD CONSTRAINT "file_texts_file_workspace_fk" FOREIGN KEY ("file_id","workspace_id") REFERENCES "public"."files"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "file_texts_workspace_file_idx" ON "file_texts" USING btree ("workspace_id","file_id");--> statement-breakpoint
CREATE INDEX "file_texts_tsv_idx" ON "file_texts" USING gin ("tsv");