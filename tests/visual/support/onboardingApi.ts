/**
 * The onboarding fixture shared by every visual-suite API installer (issue #298,
 * follow-up to epic #271; re-aligned with the platform contract by #498).
 *
 * =============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * =============================================================================
 *
 * `Layout.tsx` mounts the platform's `OnboardingProvider`, `WelcomeDialog`, the
 * user menu's "Getting started" item and this app's `OnboardingBanner` on EVERY
 * page this suite screenshots, and the provider reads `GET /api/onboarding`.
 * Each installer's `page.route('**\/api/**', ...)` handler falls through every
 * `if` to a permissive `return json(route, {})` catch-all, so a spec that never
 * answered `/onboarding` handed the provider `{}`: a truthy "state" with no
 * `settings`, which `WelcomeDialog` and `OnboardingBanner` dereference
 * (`state.settings.welcomeSeenAt`, `state.settings.adminDismissedAt`). The
 * `ErrorBoundary` then replaced the WHOLE harness page ("Something went wrong -
 * Cannot read properties of undefined"), and 125 of 136 specs failed with
 * `element(s) not found` rather than a pixel diff.
 *
 * Every installer therefore calls {@link onboardingResponse} with the path it
 * already computed, immediately before its own catch-all:
 *
 * ```ts
 * const onboarding = onboardingResponse(path, options.onboarding);
 * if (onboarding) return json(route, onboarding);
 * ```
 *
 * It returns the BODY to serve (the inner value; every installer's `json()`
 * wraps `{ data }`) for the paths it recognises, or `null` meaning "not mine".
 * It does not call `page.route` itself, so three separately-owned handlers
 * compose without ordering bugs.
 *
 * =============================================================================
 * THE SHAPE IS THE PLATFORM'S, NOT AN INVENTED ONE
 * =============================================================================
 *
 * `GET /api/onboarding` answers `OnboardingResponse` from
 * `@marinoscar/platform-contract/onboarding`: `{ settings, user, admin }` where
 * `settings` is `{ welcomeSeenAt, checklistDismissedAt, adminDismissedAt,
 * skipped }` (each `null` when unset), `user`/`admin` are blocks
 * `{ steps, completed, total, requiredDone, allResolved }` and `admin` is
 * `null` for a caller without the admin permission. There is no separate
 * `GET /api/admin/onboarding` any more. The stored namespace is written back
 * through `PATCH /api/user-settings` with `If-Match: <version>`, so
 * `/user-settings` still answers a document carrying a numeric `version`.
 *
 * =============================================================================
 * THE DEFAULT FIXTURE IS SETTLED, ON PURPOSE
 * =============================================================================
 *
 * The committed baselines show the onboarding chrome adding ZERO DOM. Unless a
 * spec opts into something else via `options.onboarding`:
 *
 *   - both blocks have `steps: []` (nothing for `OnboardingBanner` to show);
 *   - `settings.welcomeSeenAt`, `checklistDismissedAt` and `adminDismissedAt`
 *     are ALL set, because `WelcomeDialog` is open whenever
 *     `welcomeSeenAt === null` regardless of how many steps there are.
 *
 * The `'outstanding'` blocks use the real step ids, copy and tiers of the API's
 * registries, under one plausible scenario (no transcription provider yet, no
 * AI key yet), including one `blocked` step and one skippable one, because those
 * rows render differently from a plain `todo` one.
 */

/** The instant every fixture timestamp is derived from. Never `Date.now()`. */
const FIXED_ISO = '2024-03-01T09:00:00.000Z';

/** One checklist row, field for field the platform's `OnboardingStep`. */
interface FixtureStep {
  id: string;
  audience: string;
  tier: 'required' | 'recommended' | 'optional';
  status: 'done' | 'todo' | 'blocked';
  title: string;
  description: string;
  actionLabel: string;
  href: string;
  detail: string | null;
  blockedReason: string | null;
  skippable: boolean;
  skipped: boolean;
}

function step(
  partial: Omit<FixtureStep, 'audience' | 'detail' | 'blockedReason' | 'skipped'> & {
    blockedReason?: string;
  },
): FixtureStep {
  const audience = partial.id.split('.')[0] ?? 'user';
  return { audience, detail: null, blockedReason: null, skipped: false, ...partial };
}

/**
 * The deployment checklist with outstanding steps — the real seven rows from
 * `ADMIN_ONBOARDING_STEPS`, copy verbatim, under the scenario "no
 * transcription provider connected yet". `admin.smoke_test` is `blocked`
 * rather than `todo` for the identical reason the real handler computes
 * that: it cannot be attempted before `admin.transcription` lands.
 */
const ADMIN_OUTSTANDING_STEPS: FixtureStep[] = [
  step({
    id: 'admin.transcription',
    tier: 'required',
    title: 'Connect a transcription provider',
    description:
      'Choose a speech-to-text provider and store its API key. Until this is done, nobody on this deployment can upload a recording.',
    actionLabel: 'Open transcription settings',
    href: '/admin/settings/transcription',
    status: 'todo',
    skippable: false,
  }),
  step({
    id: 'admin.ai',
    tier: 'required',
    title: 'Enable AI note generation',
    description:
      'Pick an AI provider and permit at least one model. Users bring their own API keys; this decides which vendor and which models they may use.',
    actionLabel: 'Open AI settings',
    href: '/admin/settings/ai',
    status: 'todo',
    skippable: false,
  }),
  step({
    id: 'admin.smoke_test',
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
    id: 'admin.access',
    tier: 'recommended',
    title: 'Invite somebody',
    description:
      'This deployment restricts access to an email allowlist. Add the people who should be able to sign in.',
    actionLabel: 'Open users & allowlist',
    href: '/admin/settings/users',
    status: 'todo',
    skippable: true,
  }),
  step({
    id: 'admin.email',
    tier: 'recommended',
    title: 'Configure outbound email',
    description:
      'Invitations, welcome messages and notification emails need somewhere to be sent from. Without it, those notifications are only ever visible inside the app.',
    actionLabel: 'Open email settings',
    href: '/admin/settings/email',
    status: 'todo',
    skippable: true,
  }),
  step({
    id: 'admin.push',
    tier: 'recommended',
    title: 'Turn on browser notifications',
    description:
      'Generate a Web Push key pair so this deployment can raise notifications outside the browser tab. Ships disabled by default.',
    actionLabel: 'Open push settings',
    href: '/admin/settings/push',
    status: 'todo',
    skippable: true,
  }),
  step({
    id: 'admin.backup',
    tier: 'recommended',
    title: 'Schedule database backups',
    description:
      'Turn on the nightly backup so this deployment has a copy of its data to restore from.',
    actionLabel: 'Open backup settings',
    href: '/admin/settings/db-backup',
    status: 'todo',
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
    id: 'user.ai_key',
    tier: 'required',
    title: 'Add your AI provider key',
    description:
      'Notes are generated with your own API key, billed to your own account. Nobody else on this deployment can see it.',
    actionLabel: 'Add your key',
    href: '/settings/ai',
    status: 'todo',
    skippable: false,
  }),
  step({
    id: 'user.first_transcript',
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
    id: 'user.first_note',
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
    id: 'user.profile',
    tier: 'optional',
    title: 'Set your display name',
    description: 'How you appear to the people you share transcripts and notes with.',
    actionLabel: 'Edit your profile',
    href: '/settings/profile',
    status: 'todo',
    skippable: true,
  }),
];

/** A block, with the counts DERIVED from its steps so a fixture cannot contradict its own rows. */
function block(steps: readonly FixtureStep[]) {
  return {
    steps,
    completed: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
    requiredDone: steps.filter((s) => s.tier === 'required').every((s) => s.status === 'done'),
    allResolved: steps.every((s) => s.status === 'done' || s.skipped),
  };
}

/** Which shape of checklist a path should answer. `'settled'` is the zero-DOM default. */
export type ChecklistFixture = 'settled' | 'outstanding';

function checklistBlock(audience: 'admin' | 'user', fixture: ChecklistFixture) {
  if (fixture === 'settled') return block([]);
  return block(audience === 'admin' ? ADMIN_OUTSTANDING_STEPS : USER_OUTSTANDING_STEPS);
}

export interface OnboardingApiOptions {
  /** Shape of the `admin` block of `GET /api/onboarding`. Default `'settled'` (empty). */
  admin?: ChecklistFixture;
  /** Shape of the `user` block of `GET /api/onboarding`. Default `'settled'` (empty). */
  user?: ChecklistFixture;
  /**
   * Whether `settings.welcomeSeenAt` is present. Default `true`.
   *
   * THIS TOGGLES ONLY `welcomeSeenAt`, deliberately: `WelcomeDialog` opens on that
   * field alone, and the two dismissals stay set either way so turning this on
   * cannot also change `OnboardingBanner`.
   */
  welcomeSeen?: boolean;
}

/** `settings` of `GET /api/onboarding`: the stored UI state, each unset field `null`. */
function onboardingSettings(options: OnboardingApiOptions) {
  const welcomeSeen = options.welcomeSeen ?? true;
  return {
    welcomeSeenAt: welcomeSeen ? FIXED_ISO : null,
    checklistDismissedAt: FIXED_ISO,
    adminDismissedAt: FIXED_ISO,
    skipped: [] as string[],
  };
}

/**
 * The full `/user-settings` document, a plausible `UserSettings`. It MUST carry a
 * numeric `version`: the platform onboarding client reads it to send `If-Match`
 * before every write (`dismiss`/`skip`/`markWelcomeSeen`).
 */
function userSettingsBody(options: OnboardingApiOptions): Record<string, unknown> {
  const { skipped, ...stored } = onboardingSettings(options);
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
      ...Object.fromEntries(Object.entries(stored).filter(([, value]) => value !== null)),
      skipped,
    },
    updatedAt: FIXED_ISO,
    version: 1,
  };
}

/**
 * The onboarding fixture for one `/api` path, or `null` for "not mine".
 *
 * Call this BEFORE an installer's own catch-all (see the file header). The
 * returned value is the INNER body; the caller's own `json(route, ...)` supplies
 * the `{ data }` envelope.
 */
export function onboardingResponse(
  path: string,
  options: OnboardingApiOptions = {},
): Record<string, unknown> | null {
  if (path === '/onboarding') {
    return {
      settings: onboardingSettings(options),
      user: checklistBlock('user', options.user ?? 'settled'),
      admin: checklistBlock('admin', options.admin ?? 'settled'),
    };
  }
  if (path === '/user-settings') {
    return userSettingsBody(options);
  }
  return null;
}
