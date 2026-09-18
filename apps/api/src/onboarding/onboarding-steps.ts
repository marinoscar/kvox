import { PERMISSIONS } from '../common/constants/roles.constants';

// =============================================================================
// The onboarding step registry (issue #274, epic #271)
// =============================================================================
//
// Epic #271 has to answer, for one caller, "what is left to do here and where
// do I go to do it" — seven steps for an administrator setting a deployment up,
// four for an ordinary user activating their own account. Every fact behind
// those answers already exists somewhere in this application; none of it is
// invented here and none of it is stored.
//
// This file is the registry, in the shape this codebase already uses for
// `NOTIFICATION_EVENTS`, `JobHandlerRegistry` and `ADMIN_SECTIONS`: ONE ENTRY
// PER STEP, AND ADDING A STEP COSTS EXACTLY THAT ENTRY. No controller branches
// on a step key, no service has a `switch`, and the response DTO is the same
// shape for all of them.
//
// -----------------------------------------------------------------------------
// TWO FAILURE MODES THIS DESIGN EXISTS TO RULE OUT
// -----------------------------------------------------------------------------
//
// 1. STORED COMPLETION BOOLEANS LIE. An administrator who rotates the
//    transcription key out of `credentials` would keep a green tick over a
//    deployment that can no longer transcribe. So completion is DERIVED on
//    every read: nothing in this module writes a row, and the only persisted
//    onboarding state in the whole epic is the user's own INTENT (#272's
//    `onboarding` user-settings namespace — `welcomeSeenAt`, `dismissedAt`,
//    `adminDismissedAt`, `skipped[]`), which can only change because the user
//    changed it.
//
//    Rejected: persisting a step as complete the first time it is observed
//    satisfied. It is wrong in the direction that matters — a green tick over a
//    broken deployment, rather than a spurious to-do — and it turns every
//    configuration change into a stale record nobody has a path to repair.
//
// 2. A PER-STEP QUERY MAKES THE ENDPOINT'S COST A FUNCTION OF THE REGISTRY'S
//    LENGTH. Eleven steps issuing their own reads is eleven round trips that
//    grow every time somebody adds a twelfth, and the growth is invisible at
//    the call site. So A STEP NEVER ISSUES ITS OWN QUERY: `OnboardingService`
//    builds the context ONCE and hands the SAME object to every step, and the
//    types below make `ctx` the only argument either step function receives.
//
//    Rejected: letting a step run its own query behind a memo. Memoisation
//    makes the cost USUALLY bounded, which is a different property from
//    bounded, and the day somebody adds a step with an un-memoised read there
//    is no test that fails.
//
// -----------------------------------------------------------------------------
// THREE STATUSES, NOT A `satisfied` BOOLEAN
// -----------------------------------------------------------------------------
//
// `blocked` is what keeps "your administrator has not connected a transcription
// provider" distinct from "you have not recorded anything yet". It is the same
// distinction `ai-config.dto.ts` already draws by keeping `available` (may this
// deployment offer AI) and `keyConfigured` (has THIS caller pasted a key)
// independent — two different sentences, with two different fixes, and two
// different people to talk to.
//
// Collapsing them into one boolean would leave the UI to invent its own "why
// not" logic out of the remaining fields, which is exactly the conflation that
// DTO refuses.
//
// -----------------------------------------------------------------------------
// TWO CONTEXT TYPES, NOT ONE WITH NULLABLE ADMIN FACTS
// -----------------------------------------------------------------------------
//
// `OnboardingUserContext` and `OnboardingAdminContext` are separate types and
// the two arrays are typed against them separately. That is a deliberate
// compile-time guarantee behind #275's authorisation argument: a user step
// CANNOT read email settings, VAPID configuration, the backup schedule or the
// account counts, because those fields are not on the type it is handed. A
// single context with `admin: AdminFacts | null` would have made the same
// promise at runtime only, enforced by a `if (!ctx.admin) return` in every
// admin step that a later edit could forget.
//
// They are nonetheless ONE interface and ONE file, so the admin and user
// checklists cannot drift into two different shapes — which is what would
// happen if each audience got its own registry module.
// =============================================================================

/**
 * What a step reports about itself for this caller, right now.
 *
 * - `satisfied` — done. Nothing to do.
 * - `pending` — not done, and the caller can go and do it.
 * - `blocked` — not done, and the caller CANNOT do it yet because somebody
 *   else's step has to land first. Always accompanied by a `blockedReason`
 *   naming who that is.
 */
export type OnboardingStatus = 'satisfied' | 'pending' | 'blocked';

/** Which checklist a step belongs to. */
export type OnboardingAudience = 'admin' | 'user';

/**
 * How much a step matters.
 *
 * `required` steps are what `requiredRemaining` / `allRequiredSatisfied` count
 * (#275), and they are never skippable — see {@link OnboardingStep.skippable}.
 */
export type OnboardingTier = 'required' | 'recommended' | 'optional';

/** What {@link OnboardingStep.evaluate} answers. */
export interface OnboardingEvaluation {
  readonly status: OnboardingStatus;
  /**
   * Why this step cannot be performed yet. Set exactly when `status` is
   * `blocked`, and written as the sentence the UI shows — it names the person
   * who has to act, because that is the only thing a blocked step tells a user
   * that a pending one does not.
   */
  readonly blockedReason?: string;
}

/**
 * Facts both audiences' steps may read.
 *
 * Deliberately tiny. Everything else belongs to one audience or the other, and
 * putting a fact here is a decision that BOTH context builders must pay for it.
 */
export interface OnboardingBaseContext {
  /** The caller. Present so a step can be read as scoped, never so it can query. */
  readonly userId: string;

  /**
   * Whether this deployment can transcribe at all —
   * `TranscriptionConfigService.getConfig().available`, the four-fact
   * conjunction that service's header describes (enabled, a provider chosen,
   * that provider registered in this build, a key stored for it).
   *
   * Read from that service rather than re-derived: a second implementation of
   * "is transcription usable" is how a checklist ends up green on a deployment
   * whose upload button is disabled.
   */
  readonly transcription: { readonly available: boolean };
}

/**
 * Everything the USER checklist's four steps read, and nothing else.
 *
 * ⚠ No email settings, no VAPID configuration, no backup schedule, no account
 * counts. Those are admin-only facts and they are not merely filtered out of a
 * Viewer's response — with this type they are never computed on a Viewer's
 * request at all, because the builder that reads them is a different function
 * (#275).
 */
export interface OnboardingUserContext extends OnboardingBaseContext {
  readonly audience: 'user';

  /**
   * `AiConfigService.getConfig(userId)`, already per-caller.
   *
   * ⚠ `provider` and `available` are INDEPENDENT, and issue #83 is what
   * conflating them cost. `provider` names the vendor a key would belong to and
   * is populated while AI is switched off; `available` says whether anything
   * may be generated right now. `user.ai_key` below depends on the first and
   * deliberately not on the second.
   */
  readonly ai: {
    readonly available: boolean;
    readonly provider: string | null;
    readonly providerLabel: string | null;
    readonly keyConfigured: boolean;
  };

  /**
   * How many transcripts this caller owns that are not soft-deleted.
   *
   * ⚠ EXCLUDES SOFT-DELETED ROWS (`deletedAt: null`, the same filter
   * `transcripts.service.ts`'s own list and summary queries use). A count that
   * included them would tell a user who deleted their only recording that they
   * are still activated, and the checklist would never come back.
   */
  readonly ownTranscriptCount: number;

  /** How many notes this caller owns that are not soft-deleted (`deletedAt: null`). */
  readonly ownNoteCount: number;

  /**
   * `profile.displayName` from this caller's own user settings — `null` when
   * they have never set one. Whitespace is not a name; `user.profile` trims.
   */
  readonly displayName: string | null;
}

/**
 * Everything the ADMIN checklist's seven steps read, and nothing else.
 *
 * Built ONLY by `buildAdminContext`, which is reachable only from
 * `GET /api/admin/onboarding` behind `system_settings:read` (#275).
 */
export interface OnboardingAdminContext extends OnboardingBaseContext {
  readonly audience: 'admin';

  /**
   * The deployment's AI POLICY — not the per-caller config projection.
   *
   * An administrator's step is about whether the deployment is configured, and
   * `AiConfigService.getConfig`'s `available` folds in facts (a model that can
   * be budgeted, coherent token ceilings) that would make the step report
   * `pending` for reasons the AI settings page does not present as missing
   * configuration. `enabled` + `provider` + `allowedModelCount` is the exact
   * triple that page's own empty state is about.
   */
  readonly aiPolicy: {
    readonly enabled: boolean;
    readonly provider: string | null;
    readonly allowedModelCount: number;
  };

  /**
   * Transcripts this caller owns that reached `ready` — the evidence behind
   * `admin.smoke_test`. Soft-deleted rows excluded, as above.
   */
  readonly ownReadyTranscriptCount: number;

  /** `EmailSettingsService.describeForAdmin()`: a provider chosen AND switched on. */
  readonly email: { readonly configured: boolean };

  /** `PushConfigService.describeForAdmin()`: a key pair present, and switched on. */
  readonly push: { readonly configured: boolean; readonly enabled: boolean };

  /** `SystemSettingsService.getDatabaseBackupPolicy()`: is anything scheduled. */
  readonly backup: { readonly enabled: boolean };

  /** Rows in `users`. `> 1` means this administrator is not alone here. */
  readonly userCount: number;

  /** Rows in `allowed_emails`. `> 1` means somebody besides the initial admin was invited. */
  readonly allowedEmailCount: number;
}

/** Either audience's context. A step is only ever handed its own. */
export type OnboardingContext = OnboardingUserContext | OnboardingAdminContext;

/**
 * One entry of the registry. Adding a step means writing one of these and
 * nothing else — no controller edit, no service edit, no DTO edit.
 */
export interface OnboardingStep<Ctx extends OnboardingContext = OnboardingContext> {
  /**
   * Dotted, lowercase, audience-prefixed.
   *
   * ⚠ PERMANENT ONCE SHIPPED. It is persisted in the user's own
   * `onboarding.skipped[]` (#272), so renaming a key un-skips it for every
   * account that had skipped it — silently, with the step reappearing and no
   * error anywhere. Retire a key by removing the step; the stored entry is then
   * inert, exactly as that namespace's header describes.
   *
   * It must also satisfy `ONBOARDING_STEP_KEY_PATTERN`
   * (`common/schemas/user-settings-namespaces.schema.ts`) or the step becomes
   * unskippable: the PATCH that records the skip would 400 with no checklist
   * change in sight. `onboarding-steps.spec` in the service suite pins that.
   */
  readonly key: string;

  readonly audience: OnboardingAudience;
  readonly tier: OnboardingTier;

  /** Short imperative title, e.g. "Connect a transcription provider". */
  readonly title: string;

  /** One or two sentences of user-facing copy explaining why the step exists. */
  readonly description: string;

  /** The button's label, e.g. "Open transcription settings". */
  readonly actionLabel: string;

  /** Where the button goes. Root-relative, never absolute. */
  readonly href: string;

  /**
   * The EXACT permission string the destination's controller enforces — the
   * Settings UI Pattern's rule 3, applied on this axis.
   *
   * ⚠ NEVER INVENTED AND NEVER APPROXIMATED. A step whose permission the caller
   * does not hold is ABSENT from their list; it is not rendered disabled. So a
   * string no controller actually checks is a step either advertised to people
   * who will be refused at the destination, or hidden from people who would not
   * be — and both failures are silent.
   *
   * Undefined means the destination enforces no permission at all (the
   * ownership-scoped surfaces: `/api/ai-credentials`, `/api/user-settings`).
   */
  readonly permission?: string;

  /**
   * May the user dismiss this step without doing it?
   *
   * ⚠ A `required` step is NEVER skippable — `requiredRemaining` and
   * `allRequiredSatisfied` (#275) gate the epic's banner and both pages, and a
   * skippable required step would let a user switch off a warning about a
   * deployment that genuinely cannot do its job. The registry spec asserts it.
   */
  readonly skippable: boolean;

  /**
   * Is this step relevant to this caller at all?
   *
   * `false` means ABSENT from the response, not "shown as done" — a deployment
   * with no AI provider configured has no `user.ai_key` step, because there is
   * no vendor a key could belong to and showing it satisfied would be a lie.
   *
   * ⚠ PURE. `ctx` is the only argument, and it must not be mutated.
   */
  applies(ctx: Ctx): boolean;

  /**
   * What is this step's status for this caller, right now?
   *
   * ⚠ PURE, and for the reason in this file's header: the context was built
   * once, before any step ran, and a read from here would reintroduce failure
   * mode 2 invisibly.
   */
  evaluate(ctx: Ctx): OnboardingEvaluation;
}

// =============================================================================
// Admin steps — setting the DEPLOYMENT up
// =============================================================================
//
// ⚠ THE LIST STILL ENDS WITH A REAL TRANSCRIPTION, NOT A GREEN TICK ON A FORM.
// `admin.smoke_test` is the only step that proves the two required ones before
// it actually work together: a key can be saved, well-formed, accepted by the
// settings page and still be wrong — the wrong project, a revoked token, a
// region the account does not have. Every other step here reports that a form
// was filled in.
//
// ⚠ AND IT IS NONETHELESS `recommended`, NOT `required` (#299). The two facts
// are not in tension, because they are about different things: being the only
// real proof is a claim about what this step is EVIDENCE of, while the tier is
// a claim about whether this deployment is broken without it. It is not. The
// recording has to be this administrator's OWN, it spends a real call against
// the deployment's provider account, and somebody configuring a deployment for
// other people to use may reasonably never upload anything themselves. Leaving
// it `required` left that administrator's checklist permanently unable to
// settle, with no control to say so — and it could not simply gain one, because
// a `required` step is NEVER skippable (see `OnboardingStep.skippable`). So the
// step keeps its position, its argument and its blocked reason, and gains the
// skip control the honest tier allows.
//
// THE ARITHMETIC THIS CHANGES: there are TWO required admin steps, not three —
// `admin.transcription` and `admin.ai`, the pair that decides whether this
// deployment can do anything at all. `requiredRemaining` reaches zero, and the
// setup banner clears, once both providers are configured, whether or not this
// administrator ever transcribed anything personally.
//
// -----------------------------------------------------------------------------
// THIS ARRAY'S ORDER IS THE RENDERED ORDER, AND ONE PAIR OF IT IS LOAD-BEARING
// -----------------------------------------------------------------------------
//
// `OnboardingService.render` filters this array and maps it and NEVER SORTS IT,
// so the sequence written here is the sequence an administrator reads top to
// bottom. Most of that sequence is editorial and a future edit may reshuffle it
// freely. ONE PAIR MAY NOT: `admin.email` comes before `admin.access` because
// inviting somebody before outbound email works sends nothing at all, to
// nobody, with no failure surfaced anywhere. That argument is written out on
// `admin.email` itself, and `onboarding.service.spec.ts`'s registry block pins
// the pair — a dependency nothing pins is one a later edit silently reverses.
// =============================================================================

export const ADMIN_ONBOARDING_STEPS: readonly OnboardingStep<OnboardingAdminContext>[] =
  [
    {
      key: 'admin.transcription',
      audience: 'admin',
      tier: 'required',
      title: 'Connect a transcription provider',
      description:
        'Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.',
      actionLabel: 'Open transcription settings',
      href: '/admin/settings/transcription',
      // `transcription-settings.controller.ts` gates its reads on exactly this.
      permission: PERMISSIONS.SYSTEM_SETTINGS_READ,
      skippable: false,
      applies: () => true,
      evaluate: (ctx) => ({
        // The whole four-fact conjunction, borrowed rather than re-derived —
        // see `OnboardingBaseContext.transcription`.
        status: ctx.transcription.available ? 'satisfied' : 'pending',
      }),
    },
    {
      key: 'admin.ai',
      audience: 'admin',
      tier: 'required',
      title: 'Enable AI note generation',
      description:
        'Pick an AI provider and permit at least one model. Users bring their own API keys; this decides which vendor and which models they may use.',
      actionLabel: 'Open AI settings',
      href: '/admin/settings/ai',
      // `ai-settings.controller.ts` — the `ai` namespace of the `global` system
      // settings row, deliberately not a permission pair of its own.
      permission: PERMISSIONS.SYSTEM_SETTINGS_READ,
      skippable: false,
      applies: () => true,
      evaluate: (ctx) => ({
        status:
          ctx.aiPolicy.enabled &&
          ctx.aiPolicy.provider !== null &&
          ctx.aiPolicy.allowedModelCount > 0
            ? 'satisfied'
            : 'pending',
      }),
    },
    {
      key: 'admin.smoke_test',
      audience: 'admin',
      // ⚠ RECOMMENDED, NOT REQUIRED, AND THAT IS WHAT MAKES IT SKIPPABLE (#299).
      // This is the one admin step that is not a form, and it is the one an
      // administrator may legitimately decline: the recording has to be theirs,
      // it costs a real provider call against the deployment's own account, and
      // a deployment can be genuinely, correctly configured by somebody who
      // never intends to upload anything themselves. Leaving it `required` left
      // the checklist unable to settle for that administrator, with no control
      // to say so — and it could not simply gain one, because a `required` step
      // is never skippable (see `OnboardingStep.skippable`). Demoting the tier
      // is the honest fix rather than the convenient one: a step the
      // administrator may decline is, by definition, not required.
      tier: 'recommended',
      title: 'Transcribe a test recording',
      description:
        'Upload a short recording and watch it come back as a transcript. This is the only step that proves the provider key you saved actually works.',
      actionLabel: 'Upload a recording',
      href: '/transcripts/new',
      // The destination is the create surface, not a settings page:
      // `transcripts.controller.ts` enforces `transcripts:write` on `POST
      // /api/transcripts`. Seeded to all three roles, so this never hides the
      // step from an administrator.
      permission: PERMISSIONS.TRANSCRIPTS_WRITE,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.ownReadyTranscriptCount > 0) {
          return { status: 'satisfied' };
        }

        // ⚠ BLOCKED, NOT PENDING, while the provider is unconfigured. A
        // SKIPPABLE step especially must distinguish "you cannot do this yet"
        // from "you have declined this": the skip control sits right there, and
        // an administrator who reads an unexplained to-do as one they do not
        // need is making that decision on bad information — they would be
        // switching off the one check that would have caught a wrong key,
        // believing they had merely opted out of a chore. So the step says what
        // is in the way, and the fix is the step directly above this one, which
        // is worth saying out loud rather than leaving them to notice the
        // ordering.
        if (!ctx.transcription.available) {
          return {
            status: 'blocked',
            blockedReason:
              'Connect a transcription provider first — there is nothing to send a recording to yet.',
          };
        }

        return { status: 'pending' };
      },
    },
    {
      // ⚠ BEFORE `admin.access`, AND THE ORDER IS THE WHOLE POINT (#300).
      // Adding an address to the allowlist — which is what `admin.access` below
      // asks an administrator to do — is what fires the `allowlist.invitation`
      // notification, and that event declares `channels: ['email']` AND NOTHING
      // ELSE. Not because the browser channel is unimplemented: because it is
      // impossible. The recipient has no account, no session and no open tab at
      // the moment it fires — that is what being newly allowlisted means — so
      // there is no in-app channel that could reach them (read the entry's own
      // comment in `notifications/notification-events.ts`, where it is the
      // worked example of `channels` carrying real per-event information).
      //
      // So inviting somebody before outbound email works sends NOTHING AT ALL.
      // The address lands on the allowlist, the administrator sees it succeed,
      // and the invited person is simply never told they can sign in. Neither
      // of them is shown a failure, because from the application's point of
      // view nothing failed. The checklist's job here is to teach the order
      // that works: configure email, then invite.
      key: 'admin.email',
      audience: 'admin',
      tier: 'recommended',
      title: 'Configure outbound email',
      description:
        'Invitations, welcome messages and notification emails need somewhere to be sent from. Until this is configured an invitation reaches nobody at all — the person being invited has no account for it to appear in.',
      actionLabel: 'Open email settings',
      href: '/admin/settings/email',
      permission: PERMISSIONS.SYSTEM_SETTINGS_READ,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => ({
        status: ctx.email.configured ? 'satisfied' : 'pending',
      }),
    },
    {
      // ⚠ AFTER `admin.email`, deliberately — see that step's comment for why an
      // invitation issued with no outbound email configured is delivered
      // nowhere and reported to nobody.
      //
      // ⚠ AND STILL `pending`, NOT `blocked`, in that state. `blocked` is for a
      // step the caller CANNOT perform; allowlisting somebody without email is
      // something an administrator may legitimately do, having told them out of
      // band. Ordering is the honest instrument here, and `admin.email` being
      // `recommended` and skippable is the other half of the same reasoning: a
      // hard block would refuse a deployment that has decided it does not want
      // to send mail.
      key: 'admin.access',
      audience: 'admin',
      tier: 'recommended',
      title: 'Invite somebody',
      description:
        'This deployment restricts access to an email allowlist. Add the people who should be able to sign in.',
      actionLabel: 'Open users & allowlist',
      href: '/admin/settings/users',
      // `users.controller.ts` enforces `users:read` — the same string the
      // `/admin/settings/users` card carries in `ADMIN_SECTIONS`. Not
      // `allowlist:write`, which gates the allowlist tab's CONTENT rather than
      // the page's reachability; the distinction is rule 2's, and this field is
      // about reachability.
      permission: PERMISSIONS.USERS_READ,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => ({
        // `> 1` in both cases, deliberately: the seed puts INITIAL_ADMIN_EMAIL
        // on the allowlist and the first login creates that one user, so a
        // deployment nobody has been invited to still has exactly one of each.
        // `> 0` would mark this satisfied on every fresh installation.
        status:
          ctx.allowedEmailCount > 1 || ctx.userCount > 1 ? 'satisfied' : 'pending',
      }),
    },
    {
      key: 'admin.push',
      audience: 'admin',
      tier: 'recommended',
      title: 'Turn on browser notifications',
      description:
        'Generate a Web Push key pair so this deployment can raise notifications outside the browser tab. Ships disabled by default.',
      actionLabel: 'Open push settings',
      href: '/admin/settings/push',
      // `push-config.controller.ts` — its own permission pair (#355), NOT a
      // reuse of `system_settings:read`.
      permission: PERMISSIONS.PUSH_READ,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => ({
        // BOTH, and neither alone: a generated key pair with the feature
        // switched off sends nothing, and the switch cannot be honoured with no
        // key to sign with.
        status: ctx.push.configured && ctx.push.enabled ? 'satisfied' : 'pending',
      }),
    },
    {
      key: 'admin.backup',
      audience: 'admin',
      tier: 'recommended',
      title: 'Schedule database backups',
      description:
        'Turn on the nightly backup so this deployment has a copy of its data to restore from.',
      actionLabel: 'Open backup settings',
      href: '/admin/settings/db-backup',
      // `db-backup.controller.ts` — `db_backup:read`, its own permission triple.
      permission: PERMISSIONS.DB_BACKUP_READ,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => ({
        status: ctx.backup.enabled ? 'satisfied' : 'pending',
      }),
    },
  ];

// =============================================================================
// User steps — activating one ACCOUNT
// =============================================================================

export const USER_ONBOARDING_STEPS: readonly OnboardingStep<OnboardingUserContext>[] =
  [
    {
      key: 'user.ai_key',
      audience: 'user',
      tier: 'required',
      title: 'Add your AI provider key',
      description:
        'Notes are generated with your own API key, billed to your own account. Nobody else on this deployment can see it.',
      actionLabel: 'Add your key',
      href: '/settings/ai',
      // NO PERMISSION. `ai-credentials.controller.ts` is `@Auth()` with no
      // permission string — the resource is the caller's own credential, scoped
      // by `userId` in the query itself, the same ownership-scoped posture
      // `/api/pat` and `/api/user-data` take.
      skippable: false,
      // ⚠ KEYED ON `provider`, NOT ON `available` (#83). A deployment that has
      // named no vendor at all has no key for a user to add, so the step is
      // absent rather than pending against nothing.
      applies: (ctx) => ctx.ai.provider !== null,
      evaluate: (ctx) => ({
        // ⚠ ACTIONABLE AND NEVER BLOCKED while a vendor is named but AI is
        // switched off. Issue #83 deliberately populates `provider` in exactly
        // that state so a user can save a key BEFORE the administrator
        // finishes — and the first administrator of a fresh deployment has to,
        // because loading the model list `admin.ai` needs calls the vendor with
        // their own key. Blocking here would reinstate that deadlock: nobody
        // could go first.
        status: ctx.ai.keyConfigured ? 'satisfied' : 'pending',
      }),
    },
    {
      key: 'user.first_transcript',
      audience: 'user',
      tier: 'required',
      title: 'Transcribe your first recording',
      description:
        'Upload or record audio and get back a speaker-separated, timestamped transcript you can correct.',
      actionLabel: 'New transcript',
      href: '/transcripts/new',
      permission: PERMISSIONS.TRANSCRIPTS_WRITE,
      skippable: false,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.ownTranscriptCount > 0) {
          return { status: 'satisfied' };
        }

        if (!ctx.transcription.available) {
          return {
            status: 'blocked',
            // ⚠ NAMES THE ADMINISTRATOR, because that is the entire difference
            // between this and `pending`. A user staring at a disabled upload
            // button needs to know this is not their to-do and not their
            // mistake — it is somebody else's, and no amount of trying again
            // will change it.
            blockedReason:
              'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
          };
        }

        return { status: 'pending' };
      },
    },
    {
      key: 'user.first_note',
      audience: 'user',
      tier: 'recommended',
      title: 'Generate your first note',
      description:
        'Turn a transcript, a document or another note into a structured, editable note using a template.',
      actionLabel: 'New note',
      href: '/notes/new',
      permission: PERMISSIONS.NOTES_WRITE,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => {
        if (ctx.ownNoteCount > 0) {
          return { status: 'satisfied' };
        }

        // ⚠ ORDER MATTERS, AND IT IS NOT ARBITRARY. The deployment's own
        // readiness is checked FIRST: when no vendor is configured `user.ai_key`
        // is absent from this list entirely, so "add your key first" would point
        // at a step the user cannot see. Whoever has to act is named in each
        // case, which is the one thing `blocked` is for.
        if (!ctx.ai.available) {
          return {
            status: 'blocked',
            blockedReason:
              'Your administrator has not finished setting up AI generation for this deployment yet.',
          };
        }

        if (!ctx.ai.keyConfigured) {
          return {
            status: 'blocked',
            blockedReason:
              'Add your own AI provider key first — notes are generated with it.',
          };
        }

        return { status: 'pending' };
      },
    },
    {
      key: 'user.profile',
      audience: 'user',
      tier: 'optional',
      title: 'Set your display name',
      description:
        'How you appear to the people you share transcripts and notes with.',
      actionLabel: 'Edit your profile',
      href: '/settings/profile',
      // `user-settings.controller.ts`'s write path. Seeded to all three roles,
      // so this never disappears for an ordinary account.
      permission: PERMISSIONS.USER_SETTINGS_WRITE,
      skippable: true,
      applies: () => true,
      evaluate: (ctx) => ({
        // Trimmed: a name made of spaces renders as nothing, and marking that
        // satisfied would leave a user with no way to work out why their
        // initials are blank everywhere.
        status:
          ctx.displayName !== null && ctx.displayName.trim().length > 0
            ? 'satisfied'
            : 'pending',
      }),
    },
  ];
