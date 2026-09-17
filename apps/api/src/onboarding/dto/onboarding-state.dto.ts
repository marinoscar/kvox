import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// `GET /api/onboarding` and `GET /api/admin/onboarding` — response (#275)
// =============================================================================
//
// ONE SHAPE FOR BOTH ROUTES, with `audience` naming which checklist this is.
// The two routes are separately gated and read separately-built contexts
// (#274), but the body they return is the same — the admin and user checklists
// are two instances of one idea and a client renders them with one component.
// Two response shapes would be two components that drift.
//
// -----------------------------------------------------------------------------
// WHAT IS DERIVED HERE RATHER THAN LEFT TO THE CLIENT
// -----------------------------------------------------------------------------
//
// `requiredRemaining`, `totalRemaining` and `allRequiredSatisfied` are computed
// server-side. They are trivially derivable from `steps`, which is exactly the
// argument for computing them once: the banner (#277) and both pages (#278,
// #279) all gate on them, and three independent derivations are three places to
// disagree — with the disagreement showing up as a banner that says "2 steps
// left" over a page listing three.
//
// -----------------------------------------------------------------------------
// A SKIPPED STEP IS STILL RETURNED
// -----------------------------------------------------------------------------
//
// Marked `skipped: true`, counted out of the two remaining-counts, and never
// filtered out. The getting-started page has to be able to show it and offer to
// un-skip it; filtering server-side would make a skip irreversible through the
// UI, which is a one-way door on a decision the user made in one click.
//
// -----------------------------------------------------------------------------
// WHAT IS NOT HERE
// -----------------------------------------------------------------------------
//
// No `applies` result, no permission strings, no context. A step the caller
// cannot perform — because they lack the destination's permission, or because
// the step is irrelevant to this deployment — is ABSENT, and absence is the
// whole answer rather than a degraded one. Publishing the permission a step
// needs would also publish, to every account, the map of which permission
// guards which page.
// =============================================================================

export const onboardingStepStateSchema = z.object({
  key: z
    .string()
    .describe(
      'Stable step identifier, e.g. `admin.transcription`. Permanent once shipped — it is what a skip is recorded against in the caller\'s `onboarding.skipped[]` user setting (#272).',
    ),
  tier: z
    .enum(['required', 'recommended', 'optional'])
    .describe(
      '`required` steps are the ones `requiredRemaining` and `allRequiredSatisfied` count, and the only ones that are never skippable.',
    ),
  title: z.string().describe('Short imperative title for the checklist row.'),
  description: z
    .string()
    .describe('One or two sentences of user-facing copy explaining why the step exists.'),
  actionLabel: z.string().describe("Label for the step's action button."),
  href: z
    .string()
    .describe('Root-relative path the action button navigates to. Never absolute.'),
  status: z
    .enum(['satisfied', 'pending', 'blocked'])
    .describe(
      '`satisfied` — done. `pending` — not done, and the caller can go and do it. `blocked` — not done, and somebody else has to act first; `blockedReason` says who. **Derived on every read**, never stored: a persisted tick would stay green over a deployment whose provider key was rotated away.',
    ),
  blockedReason: z
    .string()
    .nullable()
    .describe(
      'Why this step cannot be performed yet, written as the sentence to show. Non-null exactly when `status` is `blocked`. It names the person who has to act, which is the only thing a blocked step tells a caller that a pending one does not.',
    ),
  skippable: z
    .boolean()
    .describe(
      'May the caller dismiss this step without doing it? Always `false` for a `required` step.',
    ),
  skipped: z
    .boolean()
    .describe(
      "Whether this step's key is in the caller's own `onboarding.skipped[]` (#272). A skipped step is still returned — the getting-started page must be able to offer to un-skip it — but it is counted out of `requiredRemaining` and `totalRemaining`.",
    ),
});

export type OnboardingStepState = z.infer<typeof onboardingStepStateSchema>;

export const onboardingStateSchema = z.object({
  audience: z
    .enum(['admin', 'user'])
    .describe(
      "Which checklist this is: `admin` for this deployment's setup steps, `user` for the caller's own activation steps. The two routes are separately gated, so this is a label rather than a mode switch.",
    ),
  steps: z
    .array(onboardingStepStateSchema)
    .describe(
      'The steps that apply to this caller, in registry order. A step whose destination permission the caller does not hold, or which is irrelevant to this deployment (no AI vendor configured, so no key to add), is **absent** rather than present-and-disabled.',
    ),
  requiredRemaining: z
    .number()
    .int()
    .describe(
      'How many `required` steps are neither satisfied nor skipped. Computed here rather than by each of the three consumers that gate on it.',
    ),
  totalRemaining: z
    .number()
    .int()
    .describe('How many steps of any tier are neither satisfied nor skipped.'),
  allRequiredSatisfied: z
    .boolean()
    .describe(
      '`requiredRemaining === 0`. Published as its own field because it is what the setup banner and both pages actually branch on.',
    ),
});

export type OnboardingState = z.infer<typeof onboardingStateSchema>;

/** Response DTO for both onboarding routes. */
export class OnboardingStateDto extends createZodDto(onboardingStateSchema) {}
