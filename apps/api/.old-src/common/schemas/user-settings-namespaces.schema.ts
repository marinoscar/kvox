import { z } from 'zod';

// =============================================================================
// User Settings Namespace: `onboarding` (the schemas)
// =============================================================================
//
// The only user namespace whose schemas still live in this file. `dataTables`,
// `navigation` and `notifications` are the PLATFORM's declarations since issue
// #466 (`@marinoscar/platform-api/settings`, `/notifications`) and `graph` is
// declared in graph/preferences/graph-preferences.schema.ts. The declaration
// that registers this namespace is `onboarding/onboarding.user-settings.ts`.
//
// CRITICAL: NO `.default()` ANYWHERE IN THIS FILE. Absent MUST mean "never
// onboarded"; the registry refuses a default at registration.
// =============================================================================

// =============================================================================
// User Settings Namespace: `onboarding` (issue #272, epic #271)
// =============================================================================
//
// WHAT THIS NAMESPACE IS FOR, AND WHAT IT DELIBERATELY IS NOT
// -----------------------------------------------------------
// Epic #271 shows a welcome dialog, a user checklist and an administrator setup
// banner on first run. Deciding whether to show any of them needs two different
// kinds of fact, and only one of them belongs here:
//
//   * READINESS — "is Google OAuth configured", "has anyone been allowlisted",
//     "does this account have an AI key". That is live system state, derived on
//     every read (#274) from the tables and settings that already hold it.
//     Nothing about it is stored here, and storing it would immediately make
//     the banner disagree with the deployment it describes.
//
//   * INTENT — "I have seen the welcome", "I have dismissed the checklist",
//     "I have dismissed the admin banner", "I explicitly skipped these steps".
//     That is the user's own decision, it has no other home in this system, and
//     it is what the four fields below record.
//
// The split is the whole design: readiness can change under the user's feet
// (an administrator configures a provider, a key is revoked) and must never be
// frozen into a settings row; intent can only change because the user changed
// it, and must survive a new browser, a new device and a cleared cache — which
// is exactly why this is a settings namespace rather than `localStorage`.
//
// ABSENT MEANS "NEVER ONBOARDED", AND THAT IS INFORMATION
// -------------------------------------------------------
// No `.default()` here, per the file header — but the argument is sharper for
// this namespace than for its neighbours. For `dataTables` a materialised
// default freezes a column set; here it would assert, on behalf of a user who
// has never seen the application, that they have already been through it.
// A `welcomeSeenAt` defaulted to anything at all means the welcome dialog is
// never shown to anybody, and the failure is silent: no error, no log line,
// just a feature that quietly does nothing for every account created after it
// shipped. The epic reads absence directly and must be able to keep doing so,
// at the namespace level (this user has never been onboarded) and at each
// field level (this user has never dismissed the admin banner).
//
// That is also why `mergeOnboarding` collapses an emptied namespace back to
// ABSENT instead of storing `{}` — see UserSettingsService. `{}` is a second
// spelling of "no opinion" for the read path to disagree with, the same trap
// `mergeNotifications` avoids on its own axis.
//
// WHY TIMESTAMPS RATHER THAN BOOLEANS
// ------------------------------------
// `welcomeSeenAt` rather than `welcomeSeen`. The extra cost is nil — both are
// one JSON field — and a boolean throws away the one piece of information that
// makes the record answerable later: WHEN. "Show the checklist again to anyone
// who dismissed it before the feature changed" is a question a timestamp can
// answer and a boolean cannot, and there is no migration path from the boolean
// to the timestamp once every account has written the boolean.
//
// SECURITY: `skipped` IS A USER-SUPPLIED ARRAY
// ---------------------------------------------
// The other three fields are bounded by their own format — an ISO-8601 string
// is finite by construction. `skipped` is not: it is a list of step keys the
// client chooses, written straight into the `user_settings.value` JSONB blob by
// the user's own PATCH. Without the two bounds below (how many entries, and
// what an entry may look like) an authenticated user can inflate a row that
// every request for their settings then reads back — the storage-exhaustion
// control this file's header describes, on the one field in this namespace that
// needs it.
//
// The key pattern is a SYNTACTIC bound, not a registry check, for the reason
// `NOTIFICATION_EVENT_KEY_PATTERN` is one: step keys are product data that
// changes with the epic's checklist, and validating against a compiled-in list
// would mean a rolling deploy where the client offers a step the server rejects
// — and would make the cleanup path (a request that NAMES a retired key)
// unreachable. An unknown step key stored here is inert: the checklist only
// ever asks whether a step it is currently rendering was skipped.
// =============================================================================

/**
 * Maximum number of step keys a single user may persist as skipped.
 *
 * Unlike DATA_TABLE_MAX_TABLES and NOTIFICATION_MAX_EVENTS_PER_CHANNEL, this
 * one CAN be expressed in zod — `skipped` is an array, not a record, so
 * `.max()` applies directly and a violation surfaces as a 400 from the
 * validation pipe rather than needing a service-side check.
 *
 * Generous against a checklist of a handful of steps — this is a bound on
 * abuse, not a product limit — but finite, because the array is user-written.
 */
export const ONBOARDING_MAX_SKIPPED = 40;

/** Maximum length of a persisted step key. */
export const ONBOARDING_MAX_STEP_KEY_LENGTH = 64;

/**
 * Allowed shape of a step key: a lowercase identifier, optionally dotted
 * (`configure_oauth`, `ai.add_key`).
 *
 * THIS IS A BOUND, NOT A REGISTRY CHECK (see the header). It must therefore
 * stay at least as permissive as the checklist's own key convention: if a
 * future step key adopts a character this pattern rejects, that step becomes
 * unskippable — a control that 400s with no checklist change in sight. Widen it
 * deliberately if the convention ever changes.
 */
export const ONBOARDING_STEP_KEY_PATTERN = /^[a-z][a-z0-9_.]*$/;

/** Step key schema, shared by the full and patch array schemas. */
export const onboardingStepKeySchema = z
  .string()
  .min(1)
  .max(ONBOARDING_MAX_STEP_KEY_LENGTH)
  .regex(ONBOARDING_STEP_KEY_PATTERN);

/**
 * Full `onboarding` namespace.
 *
 * Every field is optional and NONE has a `.default()` — see the section header.
 * `.strict()` so a typo'd field is a 400 rather than a value silently stripped
 * on the way to storage: this namespace is written by the app's own onboarding
 * code, and a misspelt `dismisedAt` that persisted as nothing would present as
 * a dialog that will not stay dismissed.
 */
export const onboardingSchema = z
  .object({
    /** When this user was shown the welcome dialog. */
    welcomeSeenAt: z.iso.datetime().optional(),
    /** When this user dismissed the onboarding checklist. */
    dismissedAt: z.iso.datetime().optional(),
    /**
     * When this user dismissed the ADMINISTRATOR setup banner.
     *
     * Separate from `dismissedAt` on purpose: the two surfaces are different
     * and an administrator is also a user. Folding them together would mean
     * dismissing the personal checklist silently hides the deployment-level
     * banner as well, which is the one of the two that is about the
     * application still being unconfigured.
     */
    adminDismissedAt: z.iso.datetime().optional(),
    /** Step keys this user explicitly skipped. Bounded — see the header. */
    skipped: z
      .array(onboardingStepKeySchema)
      .max(ONBOARDING_MAX_SKIPPED)
      .optional(),
  })
  .strict();

/**
 * PATCH form of the `onboarding` namespace: each field may additionally be
 * `null`, meaning "delete this field".
 *
 * Field-wise, like `navigationPatchSchema` and unlike `dataTablesPatchSchema`:
 * the four fields are INDEPENDENT decisions, not one coherent state, so
 * recording that the welcome was seen must not discard a previously stored
 * `skipped` list. `skipped` itself is replaced wholesale when present — it is
 * one list, and a client that sends it is stating the list it wants.
 *
 * `{ skipped: null }` deletes the list, restoring "this user has skipped
 * nothing" — which is the same state as never having skipped anything, and is
 * deliberately not spelled `[]`.
 */
export const onboardingPatchSchema = z
  .object({
    welcomeSeenAt: z.iso.datetime().nullable().optional(),
    dismissedAt: z.iso.datetime().nullable().optional(),
    adminDismissedAt: z.iso.datetime().nullable().optional(),
    skipped: z
      .array(onboardingStepKeySchema)
      .max(ONBOARDING_MAX_SKIPPED)
      .nullable()
      .optional(),
  })
  .strict();

export type OnboardingValue = z.infer<typeof onboardingSchema>;
export type OnboardingPatchValue = z.infer<typeof onboardingPatchSchema>;
