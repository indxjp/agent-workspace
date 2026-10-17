CREATE TABLE "runtime_verifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"workspace_id" uuid NOT NULL,
	"driver_id" text NOT NULL,
	"configuration_key" text NOT NULL,
	"fingerprint" text NOT NULL,
	"verified_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runtime_verifications" ADD CONSTRAINT "runtime_verifications_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "public"."workspaces"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "runtime_verifications_workspace_driver_key" ON "runtime_verifications" USING btree ("workspace_id","driver_id");