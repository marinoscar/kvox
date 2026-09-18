-- =============================================================================
-- `allowed_emails.reminder_count` and `allowed_emails.last_reminder_at`
-- (issue #301, epic #271)
-- =============================================================================
-- An administrator can press a button to nudge someone who was invited to the
-- allowlist and has not signed in yet, and the app records how many times
-- that has happened. This is a MANUAL action, not a scheduler — there is no
-- cron and no job type behind it, on the repository owner's explicit
-- instruction. A reminder is a fact about the invitation, and the invitation
-- is this row, so no new table is added.
--
-- `reminder_count` is NOT NULL with a fixed default of 0: "not yet reminded"
-- and "reminded zero times" are the same fact for every row today, unlike
-- `last_reminder_at`, where absence genuinely means "never".
--
-- `ADD COLUMN ... DEFAULT 0 NOT NULL` needs no table rewrite on PostgreSQL 11+
-- (the default is stored in the catalog, not written into every existing
-- row), so this is safe to run against a populated `allowed_emails` table
-- without a maintenance window.
--
-- `last_reminder_at` is nullable with no default: NULL is the true value for
-- every existing row, since the feature did not exist before this migration.
-- =============================================================================

-- AlterTable
ALTER TABLE "allowed_emails" ADD COLUMN "reminder_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "allowed_emails" ADD COLUMN "last_reminder_at" TIMESTAMPTZ;
