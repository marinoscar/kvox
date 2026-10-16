-- transcripts.org_id (issue #485, epic #478).
--
-- The platform sharing slice decides a record's access inside ONE organization:
-- `grants.org_id` must equal the record's `org_id`, and `AccessPolicy` denies a
-- record whose `loadOwners` organization is not the caller's active one. A
-- transcript therefore carries the organization it belongs to.
--
-- `transcripts` is deliberately NOT put under row-level security. The spike for
-- #485 found that neither `AccessPolicy` nor the sharing conformance suite asks
-- for it: `loadOwners` only has to report `{ owner, orgId }`, and the grant
-- queries run in the caller's organization scope on the `grants` table, which
-- IS under forced RLS. No policy is created here and no composite key is
-- needed (`grants` names a transcript by a plain `resource_id`, no foreign key).
--
-- Single-organization deployment: every existing transcript is backfilled with
-- the default organization (add nullable, backfill, set NOT NULL). A database
-- that holds transcripts but no default organization cannot be migrated, and the
-- migration says so instead of leaving rows with a NULL organization.
--
-- Reverse: ALTER TABLE "transcripts" DROP COLUMN "org_id";  (the foreign key
-- and the index go with the column).

BEGIN;

-- AlterTable
ALTER TABLE "transcripts" ADD COLUMN "org_id" UUID;

-- Backfill: the default organization.
UPDATE "transcripts"
   SET "org_id" = (SELECT "id" FROM "organizations" WHERE "is_default" LIMIT 1);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "transcripts" WHERE "org_id" IS NULL) THEN
    RAISE EXCEPTION 'transcripts.org_id backfill: transcripts exist but there is no default organization';
  END IF;
END
$$;

-- AlterTable
ALTER TABLE "transcripts" ALTER COLUMN "org_id" SET NOT NULL;

-- CreateIndex
CREATE INDEX "transcripts_org_id_idx" ON "transcripts"("org_id");

-- AddForeignKey
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

COMMIT;
