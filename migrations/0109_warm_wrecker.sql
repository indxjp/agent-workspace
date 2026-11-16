CREATE TABLE "demo_entry_states" (
	"entry" text PRIMARY KEY NOT NULL,
	"state" text NOT NULL,
	"reason" text NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "demo_entry_states_state_known" CHECK ("demo_entry_states"."state" in ('available', 'maintenance'))
);
