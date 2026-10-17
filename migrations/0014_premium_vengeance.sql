CREATE TABLE "share_run_charges" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"workspace_id" uuid NOT NULL,
	"share_id" uuid NOT NULL,
	"charged_usd" numeric(14, 6) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "share_run_charges_nonnegative" CHECK ("share_run_charges"."charged_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "spent_usd" SET DATA TYPE numeric(14, 6);--> statement-breakpoint
ALTER TABLE "shares" ALTER COLUMN "spent_usd" SET DEFAULT '0';--> statement-breakpoint
ALTER TABLE "share_run_charges" ADD CONSTRAINT "share_run_charges_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_run_charges" ADD CONSTRAINT "share_run_charges_share_workspace_fk" FOREIGN KEY ("share_id","workspace_id") REFERENCES "public"."shares"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "share_run_charges" ADD CONSTRAINT "share_run_charges_run_workspace_fk" FOREIGN KEY ("run_id","workspace_id") REFERENCES "public"."runs"("id","workspace_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "share_run_charges_workspace_share_idx" ON "share_run_charges" USING btree ("workspace_id","share_id");