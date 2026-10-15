-- Allowlist invitation reminders move to a KVox side table (issue #465, epic #462).
--
-- The platform's AllowedEmail model is not extensible, so the two KVox-only
-- columns allowed_emails.reminder_count and allowed_emails.last_reminder_at
-- (migration 20260918120000_add_allowlist_reminder_tracking, issue #301) are
-- replaced by kvox_allowlist_reminders, keyed by the allowlist row id.
--
-- No foreign key on purpose: AllowedEmail cannot carry a back-relation and a
-- SQL-only constraint would read as schema drift. The read path deletes orphans.
--
-- Three steps, one transaction (Prisma runs a migration file in one):
--   1. create the table;
--   2. copy every row that holds a count or a timestamp, so no reminder history
--      is lost;
--   3. drop the two deviation columns from allowed_emails.

-- CreateTable
CREATE TABLE "kvox_allowlist_reminders" (
    "allowed_email_id" UUID NOT NULL,
    "reminder_count" INTEGER NOT NULL DEFAULT 0,
    "last_reminder_at" TIMESTAMPTZ,
    "updated_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "kvox_allowlist_reminders_pkey" PRIMARY KEY ("allowed_email_id")
);

-- Preserve existing reminder history.
INSERT INTO "kvox_allowlist_reminders" ("allowed_email_id", "reminder_count", "last_reminder_at", "updated_at")
SELECT "id", "reminder_count", "last_reminder_at", now()
  FROM "allowed_emails"
 WHERE "reminder_count" > 0 OR "last_reminder_at" IS NOT NULL;

-- Drop the deviation columns.
ALTER TABLE "allowed_emails" DROP COLUMN "reminder_count",
DROP COLUMN "last_reminder_at";
