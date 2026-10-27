CREATE TABLE "storage_migration_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"finished_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rows_checked" bigint NOT NULL,
	"legacy_rows" bigint NOT NULL,
	"mismatches" bigint NOT NULL
);
--> statement-breakpoint
CREATE INDEX "storage_migration_runs_finished_idx" ON "storage_migration_runs" USING btree ("finished_at");