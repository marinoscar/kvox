import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { AiConfigService } from '../ai/ai-config.service';
import { EmailSettingsService } from '../email/email-settings.service';
import { PushConfigService } from '../notifications/push-config.service';
import { SystemSettingsService } from '../settings/system-settings/system-settings.service';
import { UserSettingsService } from '../settings/user-settings/user-settings.service';
import { TranscriptionConfigService } from '../transcription/transcription-config.service';
import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import {
  ADMIN_ONBOARDING_STEPS,
  USER_ONBOARDING_STEPS,
  type OnboardingAdminContext,
  type OnboardingAudience,
  type OnboardingContext,
  type OnboardingStep,
  type OnboardingUserContext,
} from './onboarding-steps';
import type { OnboardingState, OnboardingStepState } from './dto/onboarding-state.dto';

// =============================================================================
// OnboardingService (issue #274, epic #271)
// =============================================================================
//
// Evaluates the registry in `onboarding-steps.ts` against one caller. Three
// properties are the whole point of this file, and each of them is a thing that
// would be easy to break from a neighbouring file:
//
// -----------------------------------------------------------------------------
// 1. ONE BOUNDED READ PASS PER REQUEST, HANDED TO EVERY STEP
// -----------------------------------------------------------------------------
//
// `buildUserContext` and `buildAdminContext` each issue a fixed set of reads in
// a single `Promise.all`, and every step then evaluates against the SAME frozen
// object. Adding a step to either array changes the number of reads this
// endpoint performs by ZERO, and `onboarding.service.spec.ts` asserts exactly
// that by adding a step at test time and re-counting.
//
// The alternative — a step that reads what it needs — makes the endpoint's cost
// a function of the registry's length, and does so invisibly: nothing at the
// call site changes, no type stops it, and the eleventh round trip looks
// exactly like the first ten.
//
// -----------------------------------------------------------------------------
// 2. NOTHING IS STORED, SO NOTHING CAN GO STALE
// -----------------------------------------------------------------------------
//
// No method here writes a completion record. Every status is computed from live
// state on every read, so rotating a transcription key out of `credentials`
// flips `admin.transcription` back to `pending` on the next request with nothing
// to clear and no repair path to remember.
//
// The ONLY persisted onboarding state this service reads is the caller's own
// INTENT from #272 — `onboarding.skipped[]`. That is deliberately NOT on the
// context: readiness (derived, can change under the user's feet) and intent
// (theirs, changes only when they change it) are different kinds of fact, and
// a step's `evaluate` must not be able to see whether it was skipped. A step
// that could would eventually be written to report itself `satisfied` when
// skipped, which is the stored-completion lie arriving by another door.
//
// -----------------------------------------------------------------------------
// 3. THE ADMIN CONTEXT IS BUILT ONLY FOR THE ADMIN ROUTE
// -----------------------------------------------------------------------------
//
// `buildAdminContext` is the only function that touches `EmailSettingsService`,
// `PushConfigService`, the backup policy or the `users`/`allowed_emails` counts,
// and it is reachable only from `AdminOnboardingController` behind
// `system_settings:read` (#275). A Viewer's request does not filter those facts
// out of a response — it never computes them. The integration spec asserts that
// with spies rather than by inspecting the body, because a body assertion would
// still pass if the read happened and the value was dropped.
// =============================================================================

/**
 * One request's worth of evaluated input: the live readiness facts every step
 * reads, plus the caller's own skip list, which no step may read.
 *
 * They travel together because they are gathered in the same single read pass,
 * and they are separate fields because they are separate kinds of fact — see
 * this file's header, section 2.
 */
export interface OnboardingSnapshot<Ctx extends OnboardingContext> {
  readonly context: Ctx;
  readonly skipped: ReadonlySet<string>;
}

@Injectable()
export class OnboardingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly transcriptionConfig: TranscriptionConfigService,
    private readonly aiConfig: AiConfigService,
    private readonly userSettings: UserSettingsService,
    private readonly systemSettings: SystemSettingsService,
    private readonly emailSettings: EmailSettingsService,
    private readonly pushConfig: PushConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // The two entry points
  // ---------------------------------------------------------------------------

  /** `GET /api/onboarding` — the caller's own activation checklist. */
  async getUserState(user: RequestUser): Promise<OnboardingState> {
    const snapshot = await this.buildUserContext(user.id);

    return this.render('user', USER_ONBOARDING_STEPS, snapshot, user.permissions);
  }

  /** `GET /api/admin/onboarding` — this deployment's setup checklist. */
  async getAdminState(user: RequestUser): Promise<OnboardingState> {
    const snapshot = await this.buildAdminContext(user.id);

    return this.render('admin', ADMIN_ONBOARDING_STEPS, snapshot, user.permissions);
  }

  // ---------------------------------------------------------------------------
  // The context builders — one read pass each
  // ---------------------------------------------------------------------------

  /**
   * Everything the four user steps read, gathered once.
   *
   * ⚠ ADDING A READ HERE IS A DECISION, NOT A DETAIL. Every entry in this
   * `Promise.all` is paid for by every authenticated user on every load of the
   * getting-started page. A fact only one step needs, and only sometimes, still
   * belongs here rather than inside that step — but it is worth asking whether
   * the step needs it at all.
   *
   * ⚠ NOTHING ADMIN-ONLY MAY BE ADDED HERE. This runs for a caller holding no
   * permissions whatsoever; email settings, VAPID configuration, the backup
   * schedule and the account counts live in `buildAdminContext` and the types
   * in `onboarding-steps.ts` are what keep them unreachable from a user step.
   */
  async buildUserContext(
    userId: string,
  ): Promise<OnboardingSnapshot<OnboardingUserContext>> {
    const [transcription, ai, settings, ownTranscriptCount, ownNoteCount] =
      await Promise.all([
        this.transcriptionConfig.getConfig(),
        this.aiConfig.getConfig(userId),
        this.userSettings.getSettings(userId),
        // ⚠ `deletedAt: null`, the same visibility filter
        // `transcripts.service.ts` and `notes.service.ts` use for their own
        // lists. A count that included soft-deleted rows would tell a user who
        // deleted their only recording that they are still activated, and the
        // checklist would never come back.
        this.prisma.transcript.count({ where: { ownerId: userId, deletedAt: null } }),
        this.prisma.note.count({ where: { ownerId: userId, deletedAt: null } }),
      ]);

    return {
      context: {
        audience: 'user',
        userId,
        transcription: { available: transcription.available },
        ai: {
          available: ai.available,
          provider: ai.provider,
          providerLabel: ai.providerLabel,
          keyConfigured: ai.keyConfigured,
        },
        ownTranscriptCount,
        ownNoteCount,
        displayName: settings.profile?.displayName ?? null,
      },
      skipped: this.skippedKeys(settings),
    };
  }

  /**
   * Everything the seven admin steps read, gathered once.
   *
   * ⚠ REACHABLE ONLY FROM THE ADMIN ROUTE. See this file's header, section 3.
   * If this function ever acquires a second caller, that caller's gate becomes
   * part of the argument for whether these reads are safe.
   */
  async buildAdminContext(
    userId: string,
  ): Promise<OnboardingSnapshot<OnboardingAdminContext>> {
    const [
      transcription,
      aiPolicy,
      backup,
      email,
      push,
      settings,
      ownReadyTranscriptCount,
      userCount,
      allowedEmailCount,
    ] = await Promise.all([
      this.transcriptionConfig.getConfig(),
      // The POLICY, not `AiConfigService`'s per-caller projection — see
      // `OnboardingAdminContext.aiPolicy` for why the two answer different
      // questions and why an administrator's step is about the first one.
      this.systemSettings.getAiPolicy(),
      this.systemSettings.getDatabaseBackupPolicy(),
      this.emailSettings.describeForAdmin(),
      this.pushConfig.describeForAdmin(),
      this.userSettings.getSettings(userId),
      this.prisma.transcript.count({
        where: { ownerId: userId, deletedAt: null, status: 'ready' },
      }),
      this.prisma.user.count(),
      this.prisma.allowedEmail.count(),
    ]);

    return {
      context: {
        audience: 'admin',
        userId,
        transcription: { available: transcription.available },
        aiPolicy: {
          enabled: aiPolicy.enabled,
          provider: aiPolicy.provider,
          // Read through the policy's own active-provider axis (#78) rather
          // than a hardcoded `'openai'`: a deployment that switched vendors
          // would otherwise be judged on the list belonging to the old one.
          allowedModelCount: aiPolicy.provider
            ? (aiPolicy.providers[aiPolicy.provider]?.allowedModels.length ?? 0)
            : 0,
        },
        ownReadyTranscriptCount,
        // A provider chosen AND the feature switched on. Either alone sends no
        // mail, and reporting it configured would make a silently undelivered
        // invitation look like a working one.
        email: { configured: email.provider !== null && email.enabled },
        push: { configured: push.configured, enabled: push.enabled },
        backup: { enabled: backup.enabled },
        userCount,
        allowedEmailCount,
      },
      skipped: this.skippedKeys(settings),
    };
  }

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  /**
   * Turn a registry and a snapshot into the wire shape.
   *
   * ⚠ NO STEP KEY APPEARS IN THIS FUNCTION, and none ever may. The moment a
   * `switch (step.key)` lands here, adding a step stops costing one registry
   * entry — which is the single promise this module makes.
   */
  private render<Ctx extends OnboardingContext>(
    audience: OnboardingAudience,
    registry: readonly OnboardingStep<Ctx>[],
    snapshot: OnboardingSnapshot<Ctx>,
    permissions: readonly string[],
  ): OnboardingState {
    const held = new Set(permissions);

    const steps: OnboardingStepState[] = registry
      .filter(
        (step) =>
          // ABSENT, NOT DISABLED. A step whose destination the caller would be
          // refused at is not a to-do they can act on, and rendering it greyed
          // out asks them to go and ask for a permission the checklist has no
          // way to know they should have.
          (step.permission === undefined || held.has(step.permission)) &&
          step.applies(snapshot.context),
      )
      .map((step) => {
        const { status, blockedReason } = step.evaluate(snapshot.context);

        return {
          key: step.key,
          tier: step.tier,
          title: step.title,
          description: step.description,
          actionLabel: step.actionLabel,
          href: step.href,
          status,
          blockedReason: blockedReason ?? null,
          skippable: step.skippable,
          skipped: snapshot.skipped.has(step.key),
        };
      });

    // A step counts as outstanding when it is neither done nor waved away.
    // ⚠ `blocked` COUNTS AS OUTSTANDING. It is not satisfied, and a deployment
    // that cannot transcribe has not finished being set up merely because the
    // reason is somebody else's — the banner saying so is the point.
    const outstanding = steps.filter(
      (step) => step.status !== 'satisfied' && !step.skipped,
    );
    const requiredRemaining = outstanding.filter(
      (step) => step.tier === 'required',
    ).length;

    return {
      audience,
      steps,
      requiredRemaining,
      totalRemaining: outstanding.length,
      allRequiredSatisfied: requiredRemaining === 0,
    };
  }

  /**
   * The caller's skip list, as a set.
   *
   * Absent means "has never skipped anything", which is also what an absent
   * `onboarding` namespace means (#272) — the two collapse to the same empty
   * set here on purpose, because the distinction between them is about whether
   * the welcome dialog has been seen and has no bearing on a step's status.
   */
  private skippedKeys(settings: {
    onboarding?: { skipped?: string[] };
  }): ReadonlySet<string> {
    return new Set(settings.onboarding?.skipped ?? []);
  }
}
