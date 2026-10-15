// =============================================================================
// The `onboarding` user settings namespace (issue #272, epic #271; registered by #466)
// =============================================================================
//
// A user's own first-run INTENT: welcome seen, checklist dismissed, steps
// skipped. Declared HERE, beside the module that owns it, and registered by
// `apps/api/src/app-registrations/settings.ts` (`APP_USER_SETTINGS_NAMESPACES`).
// The schemas are in `common/schemas/user-settings-namespaces.schema.ts`.
//
// this app keeps its own declaration: the platform ships an `onboarding` user
// namespace too (`@marinoscar/platform-api/onboarding`), but its stored shape is
// not this app's, and the stored rows must read back unchanged.
//
// ABSENT MEANS "NEVER ONBOARDED": no `.default()` anywhere; registration
// refuses one.
// =============================================================================

import type { UserSettingsNamespace } from '@marinoscar/platform-api/settings';

import {
  onboardingPatchSchema,
  onboardingSchema,
  type OnboardingPatchValue,
  type OnboardingValue,
} from '../common/schemas/user-settings-namespaces.schema';

/**
 * Merge the `onboarding` namespace (#272, epic #271) field-wise.
 *
 * - patch absent                        -> keep the stored namespace untouched
 * - patch is `null`                     -> clear the whole namespace, which
 *   restores "this user has never been onboarded" and brings the first-run
 *   surfaces back. That is a real operation, not a reset for its own sake.
 * - field omitted                       -> stored value untouched
 * - field set to a value                -> replaces the stored value
 * - field set to `null`                 -> deletes the field, so that ONE
 *   surface is due again while the others stay dismissed
 *
 * FIELD-WISE, LIKE mergeNavigation, NOT WHOLESALE LIKE mergeDataTables. The
 * four fields are independent decisions about four different surfaces, and
 * the client writes exactly the one that just happened — the welcome dialog
 * closing sends `welcomeSeenAt` alone. Replacing the namespace wholesale
 * would therefore erase a previously stored `skipped` list, and every step the
 * user had skipped would reappear the first time they closed a dialog.
 *
 * `skipped` is nonetheless replaced WHOLESALE when present: it is one list
 * stating what the user has skipped, not a set of independent keys, so there
 * is no per-entry delete. `{ skipped: null }` removes the list; an empty
 * result is normalised to the same absent state rather than stored as `[]`,
 * because "has skipped nothing" and "has never skipped anything" are the same
 * fact and two spellings of one state is how a read path starts disagreeing
 * with itself. (A PUT states the settings in full and stores what it is
 * given — same asymmetry `notifications` already has.)
 *
 * COLLAPSING IS LOAD-BEARING HERE, MORE THAN ANYWHERE ELSE in this service.
 * An emptied namespace returns `undefined` so the caller omits the key
 * entirely: a stored `{}` would be a present `onboarding` key, and the whole
 * epic reads presence to decide whether this user has been onboarded at all.
 */
function mergeOnboarding(
  current: OnboardingValue | undefined,
  patch: OnboardingPatchValue | null | undefined,
): OnboardingValue | undefined {
  if (patch === undefined) {
    return current;
  }

  if (patch === null) {
    return undefined;
  }

  const merged: OnboardingValue = { ...(current ?? {}) };

  // `!== undefined`, never `??`: an explicit `null` DELETES the field, and
  // `??` would treat it as "not provided" and silently keep the stored value
  // — an un-dismiss request that returns 200 and changes nothing.
  for (const field of [
    'welcomeSeenAt',
    'dismissedAt',
    'adminDismissedAt',
  ] as const) {
    const value = patch[field];
    if (value === null) {
      delete merged[field];
    } else if (value !== undefined) {
      merged[field] = value;
    }
  }

  if (patch.skipped === null) {
    delete merged.skipped;
  } else if (patch.skipped !== undefined) {
    merged.skipped = patch.skipped;
  }

  // An empty list is the absent state, not a second spelling of it.
  if (merged.skipped !== undefined && merged.skipped.length === 0) {
    delete merged.skipped;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}


export const ONBOARDING_USER_SETTINGS: UserSettingsNamespace<
  'onboarding',
  OnboardingValue,
  OnboardingPatchValue
> = {
  key: 'onboarding',
  description: "A user's own first-run intent: welcome seen, checklist dismissed, steps skipped. Absent means never onboarded.",
  schema: onboardingSchema,
  patchSchema: onboardingPatchSchema,
  merge: mergeOnboarding,
};
