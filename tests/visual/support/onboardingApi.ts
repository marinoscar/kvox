/**
 * The onboarding fixture shared by every visual-suite API installer — issue
 * #298, follow-up to epic #271 / PR #286.
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * =============================================================================
 *
 * PR #286 mounts `OnboardingProvider`, `OnboardingBanner`, `FirstRunWelcomeDialog`
 * and `ReturnToSetupBar` in `Layout.tsx` — i.e. on EVERY page this suite
 * screenshots. Before this file, none of `support/homeApi.ts`,
 * `support/notesApi.ts` or `support/transcriptsApi.ts` answered
 * `GET /api/onboarding` / `GET /api/admin/onboarding` at all: each installer's
 * `page.route('**\/api/**', ...)` handler falls through every `if` to a
 * permissive `return json(route, {})` catch-all, so both onboarding routes
 * resolved to `{}`.
 *
 * `{}` is exactly the shape `services/onboarding.ts`'s `parseOnboardingState`
 * exists to reject — see that file's header. Today that rejection is caught
 * correctly (the provider treats it as a failed read and every consumer
 * renders nothing), which is safe but means the suite asserts NOTHING about
 * four components mounted on every one of its ~67 baselines. Before
 * `parseOnboardingState` existed, the same `{}` was stored, handed to
 * `applySkipOverlay`, and reached `state.steps.map(...)` inside
 * `OnboardingProvider`'s own render — crashing the WHOLE harness into
 * `ErrorBoundary` on every page. This file is what lets the suite move past
 * "safely renders nothing" into "renders the right thing", without
 * reintroducing that crash.
 *
 * =============================================================================
 * A HANDLER, NOT A COMPETING `page.route`
 * =============================================================================
 *
 * The three existing installers each own a single `page.route('**\/api/**', ...)`
 * call with its own big `if`/`return` chain. Playwright lets multiple `route`
 * handlers stack for the same pattern, but that buys nothing here and risks
 * ordering bugs no test would catch — so this file does not call `page.route`
 * itself. It exports a plain function, {@link onboardingResponse}, that each
 * installer calls with the path it already computed, immediately before its
 * own catch-all:
 *
 * ```ts
 * const onboarding = onboardingResponse(path, options.onboarding);
 * if (onboarding) return json(route, onboarding);
 * ```
 *
 * `onboardingResponse` returns the BODY to serve (the inner value — see below)
 * for one of the three paths it recognises, or `null` meaning "not mine, keep
 * going". That is the shape that composes with three separately-owned
 * handlers without any of them giving up ownership of their own route.
 *
 * ⚠ `json()` IN EVERY INSTALLER WRAPS IN `{ data }`. This function returns the
 * INNER value only — the same convention every fixture function in
 * `homeApi.ts`/`notesApi.ts`/`transcriptsApi.ts` already follows
 * (`summaryFor`, `noteRow`, `listItem`, …). Do not wrap it again at the call
 * site; the installer's own `json(route, onboarding)` does that once.
 *
 * =============================================================================
 * ⚠ THE DEFAULT FIXTURE IS SETTLED AND ALREADY SEEN, AND THAT IS NOT DEFENSIVE
 * =============================================================================
 *
 * ~67 existing baselines were captured with the onboarding chrome adding ZERO
 * DOM. The default answer this file gives for all three paths has to preserve
 * that, or every one of those baselines needs re-recording as a side effect of
 * a file that was supposed to be additive. So, unless a spec opts into
 * something else via `options.onboarding`:
 *
 *   - both checklists (`/onboarding`, `/admin/onboarding`) answer
 *     `steps: []`, `requiredRemaining: 0`, `totalRemaining: 0`,
 *     `allRequiredSatisfied: true` — nothing for `OnboardingBanner` or
 *     `ReturnToSetupBar` to show.
 *   - `/user-settings` answers a document whose `onboarding` namespace has
 *     `welcomeSeenAt`, `dismissedAt` and `adminDismissedAt` ALL set to a fixed
 *     ISO instant, and `skipped: []`.
 *
 * ⚠ THE THIRD PIECE IS REQUIRED, NOT DEFENSIVE, AND IS THE SINGLE MOST
 * IMPORTANT FACT IN THIS FILE. `FirstRunWelcomeDialog`'s `due` gate
 * (`components/onboarding/WelcomeDialog.tsx`) is
 * `!isLoading && !welcomeSeen && onboarding.user` — it reads NO step count at
 * all. So the moment `GET /api/onboarding` starts resolving successfully (which
 * is the whole point of this file), a modal dialog opens over every page-body
 * baseline in the suite UNLESS `welcomeSeenAt` is already present in the
 * `/user-settings` answer. An empty `steps: []` checklist does not prevent
 * this by itself — the two fixtures are independent, and skipping the
 * `/user-settings` seed (or leaving it at the old `{}`) would silently turn
 * this file from a no-op into a suite-wide regression the moment it shipped.
 *
 * =============================================================================
 * WHAT THE OPTIONS ADD, AND WHY THEY REUSE THE REAL REGISTRY
 * =============================================================================
 *
 * A future onboarding-chrome spec needs more than "nothing to show", so
 * {@link OnboardingApiOptions} can shift either checklist to `'outstanding'`
 * independently (so a spec can assert `OnboardingBanner`'s admin-wins
 * precedence — `chooseBannerAudience` — by requesting BOTH at once) and can
 * make the `/user-settings` fixture a first-run document.
 *
 * The `'outstanding'` fixtures are not invented copy. They are the real step
 * `key`/`title`/`description`/`actionLabel`/`href`/`tier`/`skippable` values
 * from `apps/api/src/onboarding/onboarding-steps.ts`
 * (`ADMIN_ONBOARDING_STEPS`/`USER_ONBOARDING_STEPS`), with a `status` assigned
 * per a single plausible scenario (a deployment with no transcription
 * provider connected yet, and a user who has not added an AI key). A fixture
 * that invented its own copy would be a baseline asserting text no real user
 * will ever see — the exact failure this task was set up to avoid. Each
 * outstanding checklist below also includes, deliberately:
 *
 *   - one `blocked` step with a `blockedReason` (`admin.smoke_test` /
 *     `user.first_transcript`), because a blocked row renders differently
 *     from a pending one (see `OnboardingStepStatus`'s own doc comment), and
 *   - one `skippable: true`, `tier: 'recommended'` step (every recommended
 *     admin step, and `user.first_note`), because that is the other row shape
 *     that renders differently (a skip control).
 *
 * The two checklists' required counts are real too: an outstanding admin
 * checklist has 3 outstanding required steps of 7 total; an outstanding user
 * checklist has 2 of 4. Nothing here recomputes `requiredRemaining`/
 * `totalRemaining`/`allRequiredSatisfied` from `steps` at the CONSUMING end —
 * `services/onboarding.ts`'s header explains why that would be a fourth
 * independent derivation of a number three components already have to agree
 * on — but this FIXTURE file is the one place a hand count is unavoidable,
 * since it is standing in for the server.
 */

/** The instant every fixture timestamp is derived from. Never `Date.now()`. */
const FIXED_ISO = '2024-03-01T09:00:00.000Z';

/** One checklist row, field for field `OnboardingStepState` (`services/onboarding.ts`). */
interface FixtureStep {
  key: string;
  tier: 'required' | 'recommended' | 'optional';
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  status: 'satisfied' | 'pending' | 'blocked';
  blockedReason: string | null;
  skippable: boolean;
  skipped: boolean;
}

function step(
  partial: Omit<FixtureStep, 'blockedReason' | 'skipped'> & { blockedReason?: string },
): FixtureStep {
  return { blockedReason: null, skipped: false, ...partial };
}

/**
 * The deployment checklist with outstanding steps — the real seven rows from
 * `ADMIN_ONBOARDING_STEPS`, copy verbatim, under the scenario "no
 * transcription provider connected yet". `admin.smoke_test` is `blocked`
 * rather than `pending` for the identical reason the real handler computes
 * that: it cannot be attempted before `admin.transcription` lands.
 */
const ADMIN_OUTSTANDING_STEPS: FixtureStep[] = [
  step({
    key: 'admin.transcription',
    tier: 'required',
    title: 'Connect a transcription provider',
    description:
      'Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.',
    actionLabel: 'Open transcription settings',
    href: '/admin/settings/transcription',
    status: 'pending',
    skippable: false,
  }),
  step({
    key: 'admin.ai',
    tier: 'required',
    title: 'Enable AI note generation',
    description:
      'Pick an AI provider and permit at least one model. Users bring their own API keys; this decides which vendor and which models they may use.',
    actionLabel: 'Open AI settings',
    href: '/admin/settings/ai',
    status: 'pending',
    skippable: false,
  }),
  step({
    key: 'admin.smoke_test',
    tier: 'required',
    title: 'Transcribe a test recording',
    description:
      'Upload a short recording and watch it come back as a transcript. This is the only step that proves the provider key you saved actually works.',
    actionLabel: 'Upload a recording',
    href: '/transcripts/new',
    status: 'blocked',
    blockedReason:
      'Connect a transcription provider first — there is nothing to send a recording to yet.',
    skippable: false,
  }),
  step({
    key: 'admin.access',
    tier: 'recommended',
    title: 'Invite somebody',
    description:
      'This deployment restricts access to an email allowlist. Add the people who should be able to sign in.',
    actionLabel: 'Open users & allowlist',
    href: '/admin/settings/users',
    status: 'pending',
    skippable: true,
  }),
  step({
    key: 'admin.email',
    tier: 'recommended',
    title: 'Configure outbound email',
    description:
      'Invitations, welcome messages and notification emails need somewhere to be sent from. Without it, those notifications are only ever visible inside the app.',
    actionLabel: 'Open email settings',
    href: '/admin/settings/email',
    status: 'pending',
    skippable: true,
  }),
  step({
    key: 'admin.push',
    tier: 'recommended',
    title: 'Turn on browser notifications',
    description:
      'Generate a Web Push key pair so this deployment can raise notifications outside the browser tab. Ships disabled by default.',
    actionLabel: 'Open push settings',
    href: '/admin/settings/push',
    status: 'pending',
    skippable: true,
  }),
  step({
    key: 'admin.backup',
    tier: 'recommended',
    title: 'Schedule database backups',
    description:
      'Turn on the nightly backup so this deployment has a copy of its data to restore from.',
    actionLabel: 'Open backup settings',
    href: '/admin/settings/db-backup',
    status: 'pending',
    skippable: true,
  }),
];

/**
 * The caller's own checklist with outstanding steps — the real four rows from
 * `USER_ONBOARDING_STEPS`, under the same "no transcription provider yet"
 * scenario plus "no AI key saved yet". `user.first_transcript` is `blocked`
 * for the same real reason `admin.smoke_test` above is; `user.first_note` is
 * `blocked` because `evaluate()` checks `ai.keyConfigured` before offering it.
 */
const USER_OUTSTANDING_STEPS: FixtureStep[] = [
  step({
    key: 'user.ai_key',
    tier: 'required',
    title: 'Add your AI provider key',
    description:
      'Notes are generated with your own API key, billed to your own account. Nobody else on this deployment can see it.',
    actionLabel: 'Add your key',
    href: '/settings/ai',
    status: 'pending',
    skippable: false,
  }),
  step({
    key: 'user.first_transcript',
    tier: 'required',
    title: 'Transcribe your first recording',
    description:
      'Upload or record audio and get back a speaker-separated, timestamped transcript you can correct.',
    actionLabel: 'New transcript',
    href: '/transcripts/new',
    status: 'blocked',
    blockedReason:
      'Your administrator has not connected a transcription provider yet, so there is nothing to send a recording to.',
    skippable: false,
  }),
  step({
    key: 'user.first_note',
    tier: 'recommended',
    title: 'Generate your first note',
    description:
      'Turn a transcript, a document or another note into a structured, editable note using a template.',
    actionLabel: 'New note',
    href: '/notes/new',
    status: 'blocked',
    blockedReason: 'Add your own AI provider key first — notes are generated with it.',
    skippable: true,
  }),
  step({
    key: 'user.profile',
    tier: 'optional',
    title: 'Set your display name',
    description: 'How you appear to the people you share transcripts and notes with.',
    actionLabel: 'Edit your profile',
    href: '/settings/profile',
    status: 'pending',
    skippable: true,
  }),
];

/** `requiredRemaining`/`totalRemaining`/`allRequiredSatisfied`, hand-counted from a step list. */
function counts(steps: readonly FixtureStep[]) {
  const remaining = steps.filter((s) => s.status !== 'satisfied' && !s.skipped);
  const requiredRemaining = remaining.filter((s) => s.tier === 'required').length;
  return {
    requiredRemaining,
    totalRemaining: remaining.length,
    allRequiredSatisfied: requiredRemaining === 0,
  };
}

/** Which shape of checklist a path should answer. `'settled'` is the ~67-baseline default. */
export type ChecklistFixture = 'settled' | 'outstanding';

function checklistBody(audience: 'admin' | 'user', fixture: ChecklistFixture): Record<string, unknown> {
  if (fixture === 'settled') {
    return { audience, steps: [], requiredRemaining: 0, totalRemaining: 0, allRequiredSatisfied: true };
  }
  const steps = audience === 'admin' ? ADMIN_OUTSTANDING_STEPS : USER_OUTSTANDING_STEPS;
  return { audience, steps, ...counts(steps) };
}

export interface OnboardingApiOptions {
  /** Shape of `GET /api/admin/onboarding`. Default `'settled'` (empty). */
  admin?: ChecklistFixture;
  /** Shape of `GET /api/onboarding`. Default `'settled'` (empty). */
  user?: ChecklistFixture;
  /**
   * Whether the `/user-settings` fixture's `onboarding.welcomeSeenAt` is
   * present. Default `true`.
   *
   * ⚠ THIS TOGGLES ONLY `welcomeSeenAt`, deliberately — `dismissedAt`/
   * `adminDismissedAt` stay at their default (set) either way.
   * `FirstRunWelcomeDialog`'s gate reads `welcomeSeen` alone (see this file's
   * header), so a fixture for exercising it needs to vary only that one field;
   * leaving the two dismissal timestamps untouched means turning this option
   * on cannot also silently change `OnboardingBanner`'s behaviour, which a
   * spec asking only for the welcome dialog did not ask to change.
   */
  welcomeSeen?: boolean;
}

/**
 * The full `/user-settings` document — a plausible `UserSettings`
 * (`apps/web/src/types/index.ts`), not just the `onboarding` namespace.
 *
 * ⚠ MUST CARRY A NUMERIC `version` — `useUserSettings`'s `write()`
 * (`hooks/useUserSettings.ts`) early-returns with no `settings` loaded, which
 * silently no-ops every PATCH a spec might exercise (`dismiss`/`skip`/
 * `markWelcomeSeen`) if this is missing. The other namespaces
 * (`profile`, `navigation`) are included as the real endpoint would send
 * them, rather than as an `onboarding`-only fragment, so a future spec
 * exercising something else this document also carries — e.g. the
 * navigation rail's collapsed preference — is not seeded with a document
 * missing half its fields.
 */
function userSettingsBody(options: OnboardingApiOptions): Record<string, unknown> {
  const welcomeSeen = options.welcomeSeen ?? true;

  return {
    theme: 'system',
    profile: {
      imageSource: 'provider',
      imageObjectId: null,
    },
    navigation: {
      railCollapsed: false,
    },
    onboarding: {
      ...(welcomeSeen ? { welcomeSeenAt: FIXED_ISO } : {}),
      dismissedAt: FIXED_ISO,
      adminDismissedAt: FIXED_ISO,
      skipped: [],
    },
    updatedAt: FIXED_ISO,
    version: 1,
  };
}

/**
 * The onboarding fixture for one `/api` path, or `null` for "not mine".
 *
 * Call this BEFORE an installer's own catch-all — see the file header. The
 * returned value is the INNER body; the caller's own `json(route, ...)` (or
 * equivalent) supplies the `{ data }` envelope.
 */
export function onboardingResponse(
  path: string,
  options: OnboardingApiOptions = {},
): Record<string, unknown> | null {
  if (path === '/onboarding') {
    return checklistBody('user', options.user ?? 'settled');
  }
  if (path === '/admin/onboarding') {
    return checklistBody('admin', options.admin ?? 'settled');
  }
  if (path === '/user-settings') {
    return userSettingsBody(options);
  }
  return null;
}
