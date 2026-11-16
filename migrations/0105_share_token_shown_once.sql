-- Part 06 step 3 phase 2: a public link is shown once, when it is created, and only its SHA-256 is
-- kept. This release is expand-only (ADR-0069): the previous release still inserts `token`, so the
-- column stays, nullable, and a trigger fills `token_hash` for its rows. The next release drops
-- `token`, its unique key, and this trigger.
-- safe: widens the column; every existing row keeps its value until the UPDATE below
ALTER TABLE "shares" ALTER COLUMN "token" DROP NOT NULL;--> statement-breakpoint
-- safe: keeps every stored hash; the column becomes a plain NOT NULL column the web process writes
ALTER TABLE "shares" ALTER COLUMN "token_hash" DROP EXPRESSION;--> statement-breakpoint
CREATE FUNCTION "public"."shares_token_hash_from_token"()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $$
BEGIN
	IF NEW."token" IS NOT NULL THEN
		NEW."token_hash" := encode(sha256(NEW."token"::bytea), 'hex');
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "shares_token_hash_from_token"
BEFORE INSERT ON "public"."shares"
FOR EACH ROW EXECUTE FUNCTION "public"."shares_token_hash_from_token"();--> statement-breakpoint
-- Lookups already go by `token_hash` (0104), so clearing the plain tokens leaves every link working.
UPDATE "shares" SET "token" = NULL WHERE "token" IS NOT NULL;
