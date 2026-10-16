-- Transcript shares become platform grants (issue #485, epic #478).
--
-- Every row of `transcript_shares` (one viewer or editor share per transcript
-- and user) becomes one ACTIVE `grants` row of resource type `transcript`:
-- the same transcript, grantee, role, grantor and creation time. Then the
-- table and its enum are dropped. The platform sharing slice
-- (`@marinoscar/platform-api/sharing`) decides access from `grants` from now on.
--
--   transcript_shares.transcript_id  ->  grants.resource_id   (resource_type 'transcript')
--   transcript_shares.user_id        ->  grants.grantee_user_id (grantee_kind 'user')
--   transcript_shares.role           ->  grants.role          ("viewer" | "editor", text)
--   transcript_shares.granted_by_id  ->  grants.granted_by_id
--   transcript_shares.created_at     ->  grants.created_at (updated_at = created_at)
--   transcripts.org_id               ->  grants.org_id
--
-- `grants` is an organization table under forced row-level security, so the
-- insert runs with the bypass on for its transaction (set_config with
-- is_local = true: transaction-local, never a session SET). Without it the
-- statement would silently insert nothing for an application role that is
-- subject to the policy.
--
-- ONE ACTIVE GRANT PER (resource, user) is the partial unique index
-- `grants_active_user_uniq_idx`; `transcript_shares` was unique on
-- (transcript_id, user_id), so every row fits. ON CONFLICT DO NOTHING makes a
-- re-run (or a grant created by hand beforehand) harmless, and the count check
-- below refuses to drop the table unless every share has its grant.
--
-- The data move and the drop are one transaction: a failure leaves
-- `transcript_shares` untouched.
--
-- REVERSE (restores the table from the live user grants; run in a transaction
-- with the bypass on; enum order, indexes and constraint names as in
-- 20260914130000_add_transcripts):
--
--   BEGIN;
--   SELECT set_config('app.rls_bypass', 'on', true);
--   CREATE TYPE "TranscriptShareRole" AS ENUM ('viewer', 'editor');
--   CREATE TABLE "transcript_shares" (
--     "id" UUID NOT NULL,
--     "transcript_id" UUID NOT NULL,
--     "user_id" UUID NOT NULL,
--     "role" "TranscriptShareRole" NOT NULL,
--     "granted_by_id" UUID NOT NULL,
--     "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
--     CONSTRAINT "transcript_shares_pkey" PRIMARY KEY ("id")
--   );
--   CREATE UNIQUE INDEX "transcript_shares_transcript_id_user_id_key"
--     ON "transcript_shares"("transcript_id", "user_id");
--   ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_transcript_id_fkey"
--     FOREIGN KEY ("transcript_id") REFERENCES "transcripts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_user_id_fkey"
--     FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   ALTER TABLE "transcript_shares" ADD CONSTRAINT "transcript_shares_granted_by_id_fkey"
--     FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   -- A grant whose grantor was deleted (granted_by_id NULL) falls back to the owner.
--   INSERT INTO "transcript_shares" ("id", "transcript_id", "user_id", "role", "granted_by_id", "created_at")
--   SELECT gen_random_uuid(), g."resource_id", g."grantee_user_id", g."role"::"TranscriptShareRole",
--          COALESCE(g."granted_by_id", t."owner_id"), g."created_at"
--     FROM "grants" g JOIN "transcripts" t ON t."id" = g."resource_id"
--    WHERE g."resource_type" = 'transcript' AND g."grantee_kind" = 'user'
--      AND g."revoked_at" IS NULL AND (g."expires_at" IS NULL OR g."expires_at" > now())
--      AND g."role" IN ('viewer', 'editor');
--   DELETE FROM "grants" WHERE "resource_type" = 'transcript';
--   COMMIT;
--
-- (The reverse above is for the table only; it does not revert the code, and
-- the group and link grants the new API can create are not representable in the
-- old table: a rollback to the old build keeps user viewer/editor shares only.
-- The `DELETE` is optional if the grants are to be kept for a later roll-forward.)

BEGIN;
SELECT set_config('app.rls_bypass', 'on', true);

INSERT INTO "grants" (
  "id", "org_id", "resource_type", "resource_id", "grantee_kind", "grantee_user_id",
  "role", "granted_by_id", "created_at", "updated_at"
)
SELECT gen_random_uuid(), t."org_id", 'transcript', s."transcript_id", 'user', s."user_id",
       s."role"::text, s."granted_by_id", s."created_at", s."created_at"
  FROM "transcript_shares" s
  JOIN "transcripts" t ON t."id" = s."transcript_id"
ON CONFLICT DO NOTHING;

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing
    FROM "transcript_shares" s
    JOIN "transcripts" t ON t."id" = s."transcript_id"
   WHERE NOT EXISTS (
     SELECT 1 FROM "grants" g
      WHERE g."org_id" = t."org_id"
        AND g."resource_type" = 'transcript'
        AND g."resource_id" = s."transcript_id"
        AND g."grantee_kind" = 'user'
        AND g."grantee_user_id" = s."user_id"
        AND g."role" = s."role"::text
        AND g."revoked_at" IS NULL
   );
  IF missing > 0 THEN
    RAISE EXCEPTION 'transcript_shares to grants: % share(s) have no matching active grant; not dropping the table', missing;
  END IF;
END
$$;

-- DropTable
DROP TABLE "transcript_shares";

-- DropEnum
DROP TYPE "TranscriptShareRole";

COMMIT;
