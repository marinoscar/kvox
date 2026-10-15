// =============================================================================
// Core user settings namespaces (issue #459)
// =============================================================================
//
// `dataTables`, `navigation`, `notifications` and `onboarding`: the optional
// namespaces of `user_settings.value` that belong to the framework. `graph` is
// declared in `graph/preferences/graph.user-settings.ts`; `kvox.manifest.ts`
// registers them all, in the order that is the composed schemas' key order.
// `theme` and `profile` are core FIELDS, not namespaces (`core-user-fields.ts`).
//
// The schemas are the ones in `common/schemas/user-settings-namespaces.schema.ts`
// (stored, PUT and response bodies share one schema per namespace, so the
// declarations leave `putSchema` and `responseSchema` to default to `schema`).
//
// The `merge` functions and `assertLimits` are the bodies of
// `UserSettingsService.mergeDataTables/mergeNavigation/mergeNotifications/
// mergeOnboarding` and `assertDataTableLimit/assertNotificationLimit`, copied
// VERBATIM (pure functions, same text, same comments). The service keeps its
// private copies until it merges through the registry; the specs in
// `settings/user-settings/` pin the behaviour of both.
//
// NO `.default()` ANYWHERE: absent means "use the built-in defaults" (see the
// header of `user-settings-namespaces.schema.ts`); registration refuses one.
// =============================================================================

import { BadRequestException } from '@nestjs/common';

import {
  DATA_TABLE_MAX_TABLES,
  NOTIFICATION_MAX_EVENTS_PER_CHANNEL,
  dataTablesPatchSchema,
  dataTablesSchema,
  navigationPatchSchema,
  navigationSchema,
  notificationsPatchSchema,
  notificationsSchema,
  onboardingPatchSchema,
  onboardingSchema,
  type DataTablesPatchValue,
  type DataTablesValue,
  type NavigationPatchValue,
  type NavigationValue,
  type NotificationChannelPreferencesValue,
  type NotificationsPatchValue,
  type NotificationsValue,
  type OnboardingPatchValue,
  type OnboardingValue,
} from '../../common/schemas/user-settings-namespaces.schema';
import type { NotificationChannel } from '../../notifications/notification-events';
import type { UserSettingsNamespace } from './user-settings-namespace';

declare module './index' {
  interface UserSettingsNamespaces {
    dataTables: DataTablesValue;
    navigation: NavigationValue;
    notifications: NotificationsValue;
    onboarding: OnboardingValue;
  }
}

// -----------------------------------------------------------------------------
// Merges and limits (copied verbatim from `UserSettingsService`)
// -----------------------------------------------------------------------------

/**
 * Merge the `dataTables` namespace using JSON Merge Patch semantics,
 * PER TABLE ID.
 *
 * - patch absent            -> keep the stored namespace untouched
 * - patch is `null`         -> clear the whole namespace
 * - `{ jobs: null }`        -> delete the `jobs` entry, leave others alone
 * - `{ jobs: { pageSize } }`-> REPLACE the `jobs` entry wholesale. This is
 *   deliberately not a deep merge: a table's preferences are a single
 *   coherent view state, and a client that sends a partial entry is stating
 *   the entry it wants, so any previously stored `density` for `jobs` is
 *   discarded. Entries for other tables are never affected.
 *
 * An empty result collapses to `undefined` so the namespace disappears from
 * storage rather than persisting as `{}`.
 */
function mergeDataTables(
  current: DataTablesValue | undefined,
  patch: DataTablesPatchValue | null | undefined,
): DataTablesValue | undefined {
  if (patch === undefined) {
    return current;
  }

  if (patch === null) {
    return undefined;
  }

  const merged: DataTablesValue = { ...(current ?? {}) };

  for (const [tableId, entry] of Object.entries(patch)) {
    if (entry === null) {
      delete merged[tableId];
    } else if (entry !== undefined) {
      merged[tableId] = entry;
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Merge the `navigation` namespace field-wise.
 *
 * - patch absent           -> keep the stored namespace untouched
 * - patch is `null`        -> clear the whole namespace
 * - field omitted          -> stored value untouched
 * - field set to a value   -> replaces the stored value
 * - field set to `null`    -> deletes the field, so the client falls back to
 *   its built-in default rather than to a hard-coded stored one
 *
 * As with dataTables, an empty result collapses to `undefined`.
 */
function mergeNavigation(
  current: NavigationValue | undefined,
  patch: NavigationPatchValue | null | undefined,
): NavigationValue | undefined {
  if (patch === undefined) {
    return current;
  }

  if (patch === null) {
    return undefined;
  }

  const merged: NavigationValue = { ...(current ?? {}) };

  if (patch.railCollapsed === null) {
    delete merged.railCollapsed;
  } else if (patch.railCollapsed !== undefined) {
    merged.railCollapsed = patch.railCollapsed;
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

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

/**
 * Merge the `notifications` namespace (#126, epic #109) using JSON Merge
 * Patch semantics, PER CHANNEL and then PER EVENT KEY.
 *
 * - patch absent                       -> keep the stored namespace untouched
 * - patch is `null`                    -> clear the whole namespace
 * - `{ email: null }`                  -> clear the `email` channel, leaving
 *   any `browser` preferences alone
 * - `{ email: { 'user.welcome': null } }` -> DELETE that one event key, so
 *   the event falls back to the registry's `defaultEnabled`. This is the
 *   operation the preferences page sends when a control returns to its
 *   default; storing the default value instead would pin that user to
 *   today's default forever and re-materialise the key the sparse contract
 *   exists to keep absent.
 * - `{ email: { 'user.welcome': false } }` -> set that one key, touching
 *   nothing else on the channel.
 *
 * WHY THIS DEEP-MERGES WHERE mergeDataTables REPLACES. A data table entry is
 * one coherent view state, so a client sending it is stating the whole
 * entry. A channel's preferences are the opposite: a row of INDEPENDENT
 * per-event choices, and #126 PATCHes exactly the one key the user just
 * toggled. Replacing the channel wholesale would therefore erase every other
 * preference on that channel on every single toggle — silently re-enabling
 * mail the user had already turned off, which is the loudest possible
 * regression for a notifications feature.
 *
 * COLLAPSING IS LOAD-BEARING AT BOTH LEVELS. A channel whose last key was
 * deleted is removed rather than stored as `{}`, and an empty namespace
 * returns `undefined` so the caller omits the key entirely. Absent means
 * "use the built-in defaults"; `{}` is a second spelling of the same state
 * that the read path does not produce (`readNotificationPreferences` drops
 * empty maps too), and two spellings of one state is how the UI and the
 * dispatcher end up disagreeing about whether a user has an opinion.
 *
 * DELIBERATELY NO `mandatory` CHECK HERE. A stored `false` for a mandatory
 * event is accepted and is inert: `isChannelEnabled` (#125) tests
 * `event.mandatory` before it ever looks at stored preferences, so the value
 * is never consulted. That resolver is the single security gate on purpose —
 * it also covers rows written before an event became mandatory, and requests
 * that never went near the UI. A second gate here could only disagree with
 * the one that actually decides delivery.
 *
 * Event keys are NOT validated against the registry — see the header of
 * user-settings-namespaces.schema.ts for the three ways that breaks.
 */
function mergeNotifications(
  current: NotificationsValue | undefined,
  patch: NotificationsPatchValue | null | undefined,
): NotificationsValue | undefined {
  if (patch === undefined) {
    return current;
  }

  if (patch === null) {
    return undefined;
  }

  const merged: NotificationsValue = {};

  // Copy the stored namespace one level deep. A shallow `{ ...current }`
  // would share the per-channel objects with the value we just read, and the
  // `delete` below would then mutate them in place.
  for (const [channel, events] of Object.entries(current ?? {})) {
    if (events !== undefined) {
      merged[channel as NotificationChannel] = { ...events };
    }
  }

  for (const [channel, channelPatch] of Object.entries(patch)) {
    const key = channel as NotificationChannel;

    if (channelPatch === null) {
      delete merged[key];
      continue;
    }

    if (channelPatch === undefined) {
      continue;
    }

    const events: NotificationChannelPreferencesValue = {
      ...(merged[key] ?? {}),
    };

    for (const [eventKey, choice] of Object.entries(channelPatch)) {
      if (choice === null) {
        delete events[eventKey];
      } else if (choice !== undefined) {
        events[eventKey] = choice;
      }
    }

    if (Object.keys(events).length > 0) {
      merged[key] = events;
    } else {
      // Last key deleted: the channel goes away rather than persisting as
      // `{}`. See "COLLAPSING IS LOAD-BEARING" above.
      delete merged[key];
    }
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Enforce the per-user cap on persisted notification preferences.
 *
 * The event level is an OPEN map — event keys are registry data and are
 * deliberately not validated against the registry (see
 * user-settings-namespaces.schema.ts) — so without a cap an authenticated
 * user can inflate their own `user_settings` row without limit by PATCHing
 * arbitrary keys. The channel level is closed by the enum, so bounding the
 * entries per channel bounds the namespace.
 *
 * Enforced here, not in zod, for the same two reasons as
 * assertDataTableLimit: `z.record()` has no key-count refinement, and the
 * cap has to be checked against the MERGED result rather than the request
 * body. A ZodError thrown from the service would escape as a 500 instead of
 * the 400 the client deserves, hence the explicit BadRequestException.
 */
function assertNotificationLimit(
  notifications: NotificationsValue | undefined,
): void {
  if (!notifications) {
    return;
  }

  for (const [channel, events] of Object.entries(notifications)) {
    const count = Object.keys(events ?? {}).length;
    if (count > NOTIFICATION_MAX_EVENTS_PER_CHANNEL) {
      throw new BadRequestException(
        `Too many notification preferences for channel "${channel}": ${count} exceeds the maximum of ${NOTIFICATION_MAX_EVENTS_PER_CHANNEL}. Remove preferences you no longer need (send them as null) before adding new ones.`,
      );
    }
  }
}

/**
 * Enforce the per-user cap on the number of persisted data table entries.
 *
 * This is a storage-exhaustion control (see
 * user-settings-namespaces.schema.ts), and it is enforced HERE rather than in
 * zod for two reasons:
 *
 * 1. `z.record()` cannot express "at most N keys" — there is no key-count
 *    refinement that survives the record type.
 * 2. Even if it could, the cap has to be checked against the MERGED result,
 *    not the request body: a 3-entry patch on top of 39 stored entries is
 *    over the cap while the body alone is not. Doing that check inside the
 *    post-merge `userSettingsSchema.parse()` would surface it as a raw
 *    `ZodError` thrown from the service — which escapes as a 500, not the
 *    400 the client deserves. Hence an explicit BadRequestException.
 */
function assertDataTableLimit(dataTables: DataTablesValue | undefined): void {
  if (!dataTables) {
    return;
  }

  const count = Object.keys(dataTables).length;
  if (count > DATA_TABLE_MAX_TABLES) {
    throw new BadRequestException(
      `Too many data table preferences: ${count} exceeds the maximum of ${DATA_TABLE_MAX_TABLES}. Remove entries for tables you no longer use (send them as null) before adding new ones.`,
    );
  }
}

// -----------------------------------------------------------------------------
// Declarations
// -----------------------------------------------------------------------------

export const DATA_TABLES_USER_SETTINGS: UserSettingsNamespace<
  'dataTables',
  DataTablesValue,
  DataTablesPatchValue
> = {
  key: 'dataTables',
  description: 'Per-table view preferences (density, visible columns, sort, page size), keyed by table id.',
  schema: dataTablesSchema,
  // The outer `.nullable()` (composed) lets `{ "dataTables": null }` clear the
  // whole namespace; the inner nullability lets `{ "dataTables": { "jobs": null } }`
  // delete a single entry.
  patchSchema: dataTablesPatchSchema,
  merge: mergeDataTables,
  assertLimits: assertDataTableLimit,
};

export const NAVIGATION_USER_SETTINGS: UserSettingsNamespace<
  'navigation',
  NavigationValue,
  NavigationPatchValue
> = {
  key: 'navigation',
  description: 'Navigation chrome preferences, such as whether the rail is collapsed.',
  schema: navigationSchema,
  patchSchema: navigationPatchSchema,
  merge: mergeNavigation,
};

export const NOTIFICATIONS_USER_SETTINGS: UserSettingsNamespace<
  'notifications',
  NotificationsValue,
  NotificationsPatchValue
> = {
  key: 'notifications',
  description: "A user's per-channel, per-event notification preferences; absent means each event's registry default.",
  schema: notificationsSchema,
  // Three nullable levels, three different deletes: the namespace, one
  // channel, one event key.
  patchSchema: notificationsPatchSchema,
  merge: mergeNotifications,
  assertLimits: assertNotificationLimit,
};

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

/**
 * The core user namespaces, in the order that is the composed schemas' key
 * order. `kvox.manifest.ts` appends `graph` after these.
 */
export const CORE_USER_NAMESPACES: readonly UserSettingsNamespace[] = [
  DATA_TABLES_USER_SETTINGS,
  NAVIGATION_USER_SETTINGS,
  NOTIFICATIONS_USER_SETTINGS,
  ONBOARDING_USER_SETTINGS,
];
