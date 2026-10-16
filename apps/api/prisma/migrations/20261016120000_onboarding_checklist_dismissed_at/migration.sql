-- Onboarding intent moves to the platform's `onboarding` user-settings namespace
-- (issue #481, epic #478).
--
-- The platform slice stores the same four decisions this app always stored in
-- `user_settings.value -> 'onboarding'`, with one field renamed:
--
--   welcomeSeenAt      unchanged
--   dismissedAt        -> checklistDismissedAt   (the Getting started checklist)
--   adminDismissedAt   unchanged
--   skipped            unchanged (step ids; ids the platform no longer registers
--                      as skippable are filtered on read and dropped by the next
--                      write, so no rewrite is needed here)
--
-- The platform namespace is STRICT: a stored `dismissedAt` would fail the parse
-- of the whole namespace, so every row is renamed before the new build reads it.
--
-- Idempotent. A row that already carries `checklistDismissedAt` keeps it (the
-- newer key wins) and only loses the stale `dismissedAt`; a row with neither is
-- untouched; a row whose `onboarding` is not an object is left alone. A re-run
-- matches nothing, because no row has `dismissedAt` afterwards.
--
-- Reverse, for a rollback to the previous build (run by hand, not shipped):
--
--   UPDATE user_settings
--      SET value = jsonb_set(
--            value #- '{onboarding,checklistDismissedAt}',
--            '{onboarding,dismissedAt}',
--            value -> 'onboarding' -> 'checklistDismissedAt')
--    WHERE jsonb_typeof(value -> 'onboarding') = 'object'
--      AND value -> 'onboarding' ? 'checklistDismissedAt';

UPDATE "user_settings"
   SET "value" = jsonb_set(
         "value" #- '{onboarding,dismissedAt}',
         '{onboarding,checklistDismissedAt}',
         COALESCE(
           "value" -> 'onboarding' -> 'checklistDismissedAt',
           "value" -> 'onboarding' -> 'dismissedAt'
         )
       )
 WHERE jsonb_typeof("value" -> 'onboarding') = 'object'
   AND "value" -> 'onboarding' ? 'dismissedAt';
