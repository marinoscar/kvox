/**
 * The onboarding API, as the web app sees it — issue #276, epic #271.
 *
 * Shaped after `services/transcription.ts` and `services/ai.ts`:
 * `services/api.ts` stays the transport (the `ApiService` instance, the refresh
 * dance, the maintenance recogniser, the `{ data, meta }` unwrap) and this
 * module holds the two calls next to the types they produce.
 *
 * =============================================================================
 * TWO ROUTES, AND THE SPLIT IS THE AUTHORISATION MODEL — NOT A CONVENIENCE
 * =============================================================================
 *
 * `GET /api/onboarding` is `@Auth()` with no permission string; it answers the
 * caller's own activation steps. `GET /api/admin/onboarding` is
 * `system_settings:read`; it answers this deployment's setup steps. #275
 * rejected one endpoint serving both on the ground that it would have to decide
 * per caller which half of its own body to withhold — the same argument
 * `HomePage.tsx` already makes against `GET /api/home/summary`.
 *
 * That split is load-bearing HERE too, and it is why this file exposes two
 * functions rather than one with an `audience` argument: the gate must be a
 * property of the route, so a caller that must not ask can simply not call
 * {@link getAdminOnboardingState}. `OnboardingContext` holds that decision
 * (`hasPermission('system_settings:read')`), and it can only hold it because
 * the two requests are two functions.
 *
 * =============================================================================
 * ONE RESPONSE SHAPE FOR BOTH, DELIBERATELY
 * =============================================================================
 *
 * The API returns the identical body from both routes with `audience` naming
 * which checklist it is (see the header of
 * `apps/api/src/onboarding/dto/onboarding-state.dto.ts`). That is what lets the
 * admin setup page (#278) and the getting-started page (#279) render through
 * ONE `SetupChecklist`. Two response types here would be two components later,
 * and the second one is where the accessibility work gets skipped.
 *
 * =============================================================================
 * NO LOGIC IN THIS FILE, AND THAT IS A RULE RATHER THAN AN OBSERVATION
 * =============================================================================
 *
 * `requiredRemaining`, `totalRemaining` and `allRequiredSatisfied` are all
 * trivially derivable from `steps`, and #275 computes them server-side anyway —
 * precisely because the banner (#277) and both pages gate on them and three
 * independent derivations are three places to disagree, with the disagreement
 * surfacing as a banner reading "2 steps left" above a page listing three. A
 * convenience helper here that recomputed any of them would be the fourth.
 *
 * The one derivation that does exist in this epic is the transient skip overlay
 * in `contexts/OnboardingContext.tsx`, and it lives there rather than here
 * because it is about a write that has not landed yet, not about the wire.
 */

import { api } from './api';

// =============================================================================
// The wire types — mirrored field for field from the API's Zod schemas
// =============================================================================
//
// `apps/api/src/onboarding/dto/onboarding-state.dto.ts` is the source of truth.
// These are restated rather than imported because `apps/web` does not depend on
// `apps/api` (only on `@app/shared`), which is the same reason
// `services/transcription.ts` and `services/ai.ts` restate theirs.
// =============================================================================

/**
 * Which checklist a response is.
 *
 * A LABEL, NOT A MODE SWITCH. The two routes are separately gated and read
 * separately-built contexts, so nothing branches on this to decide what it is
 * allowed to show — it is here so a consumer holding both states can tell them
 * apart, and so `dismiss()` can record the right one of the two dismissal
 * timestamps (`dismissedAt` vs `adminDismissedAt`, #272).
 */
export type OnboardingAudience = 'admin' | 'user';

/**
 * How much a step matters.
 *
 * `required` is the tier `requiredRemaining` and `allRequiredSatisfied` count,
 * and the only tier that is never skippable — so a `required` step arriving
 * with `skippable: true` would be a server bug, and the checklist renders what
 * the server said rather than second-guessing it.
 */
export type OnboardingTier = 'required' | 'recommended' | 'optional';

/**
 * Where a step stands.
 *
 * ⚠ THE DIFFERENCE BETWEEN `pending` AND `blocked` IS WHO HAS TO ACT, and it is
 * the only thing a blocked step tells a caller that a pending one does not.
 * `pending` means "not done, and you can go and do it"; `blocked` means "not
 * done, and somebody else has to act first", with `blockedReason` naming them.
 * Rendering the two the same way — a greyed row either way — throws away the
 * one fact the user needs in order to know whether to wait or to click.
 *
 * Derived on every read, never stored: a persisted tick would stay green over a
 * deployment whose provider key was rotated away.
 */
export type OnboardingStepStatus = 'satisfied' | 'pending' | 'blocked';

/** One row of a checklist. */
export interface OnboardingStepState {
  /**
   * Stable identifier, e.g. `admin.transcription`.
   *
   * PERMANENT once shipped — it is what a skip is recorded against in the
   * caller's `onboarding.skipped[]` user setting (#272), so renaming one
   * silently un-skips it for everybody who had skipped it.
   */
  key: string;
  tier: OnboardingTier;
  /** Short imperative title for the row. */
  title: string;
  /** One or two sentences of user-facing copy explaining why the step exists. */
  description: string;
  /** Label for the row's action button. */
  actionLabel: string;
  /** Root-relative path the action navigates to. Never absolute. */
  href: string;
  status: OnboardingStepStatus;
  /**
   * Why this step cannot be performed yet, written as the sentence to show.
   * Non-null exactly when `status` is `blocked`.
   */
  blockedReason: string | null;
  /** May the caller dismiss this step without doing it? Always `false` for `required`. */
  skippable: boolean;
  /**
   * Whether this step's key is in the caller's own `onboarding.skipped[]`.
   *
   * A skipped step is still RETURNED, never filtered out — the getting-started
   * page has to be able to show it and offer to un-skip it. It is simply
   * counted out of the two remaining-counts below.
   */
  skipped: boolean;
}

/** A whole checklist, as either route returns it. */
export interface OnboardingState {
  audience: OnboardingAudience;
  /**
   * The steps that apply to this caller, in registry order.
   *
   * A step whose destination permission the caller does not hold, or which is
   * irrelevant to this deployment (no AI vendor configured, so no key to add),
   * is ABSENT rather than present-and-disabled. Absence is the whole answer.
   */
  steps: OnboardingStepState[];
  /** How many `required` steps are neither satisfied nor skipped. */
  requiredRemaining: number;
  /** How many steps of any tier are neither satisfied nor skipped. */
  totalRemaining: number;
  /** `requiredRemaining === 0`. What the banner and both pages actually branch on. */
  allRequiredSatisfied: boolean;
}

// =============================================================================
// The two calls
// =============================================================================

/**
 * The path of the caller's own checklist.
 *
 * Exported as a constant so the provider's test can assert WHICH route was hit
 * rather than merely how many were, and so a typo in either place fails the
 * suite instead of producing a 404 that the provider swallows into "render
 * nothing" (see requirement 6 in the issue).
 */
export const ONBOARDING_PATH = '/onboarding';

/** The path of the deployment's checklist. `system_settings:read`. */
export const ADMIN_ONBOARDING_PATH = '/admin/onboarding';

/**
 * `GET /api/onboarding` — the caller's own activation steps.
 *
 * Safe for every signed-in account, including a Viewer with no permissions at
 * all: the resource is the caller's own state, scoped by `userId` in the query
 * itself, which is the ownership-scoped posture `/api/pat` and
 * `/api/ai-credentials` already take.
 */
export async function getOnboardingState(): Promise<OnboardingState> {
  return api.get<OnboardingState>(ONBOARDING_PATH);
}

/**
 * `GET /api/admin/onboarding` — this deployment's setup steps.
 *
 * ⚠ CALL THIS ONLY BEHIND `hasPermission('system_settings:read')`. For anyone
 * else it is a guaranteed 403, and the session in memory already knows the
 * answer before the request would be made — the same reasoning
 * `MaintenanceBanner` gives for not firing `GET /api/admin/maintenance` on
 * behalf of every viewer in the shell. The gate lives in
 * `contexts/OnboardingContext.tsx`; there is nothing to check here, because a
 * function that checked would have to be given the permission set and would
 * then be the second place that decision is made.
 */
export async function getAdminOnboardingState(): Promise<OnboardingState> {
  return api.get<OnboardingState>(ADMIN_ONBOARDING_PATH);
}
