ALTER TABLE "store_leads" ADD COLUMN "enquiry_setup" jsonb;--> statement-breakpoint
ALTER TABLE "store_leads" ADD COLUMN "launch_notices" text[] DEFAULT '{}'::text[] NOT NULL;