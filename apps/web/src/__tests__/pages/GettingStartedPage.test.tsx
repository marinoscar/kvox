/**
 * `GettingStartedPage` (`/settings/getting-started`) — issue #279, epic #271.
 *
 * ⚠ THE BYOK EXPLAINER IS WHAT THIS PAGE IS FOR, so it gets the strongest
 * assertions in the file: all three facts present, and present ABOVE the
 * checklist. Order is asserted through the DOM rather than eyeballed, because
 * copy that has drifted below the list is copy that arrives at the same moment
 * `AiKeyRequired` would have — which is the failure the page exists to prevent.
 *
 * The rest is the registry contract (a card with NO permission, an ungated
 * route), the two behaviours the criteria name (an Undo that issues one
 * `unskip`, a replay that does not touch `welcomeSeenAt`), and what the page
 * deliberately does NOT offer on a blocked step.
 *
 * The provider is stubbed; see `onboardingContext`'s comment in
 * `onboardingFixtures.ts` for why, and `OnboardingContext.test.tsx` for the
 * wiring this file does not re-prove.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const mockNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom');
  return { ...actual, useNavigate: () => mockNavigate };
});

import { render, mockUser, type MockUser } from '../utils/test-utils';
import GettingStartedPage, {
  AI_SETTINGS_PATH,
  BYOK_FACTS,
  PAGE_DESCRIPTION,
  PAGE_TITLE,
} from '../../pages/GettingStartedPage';
import { GETTING_STARTED_PATH } from '../../components/onboarding/onboardingPaths';
import { OnboardingContext } from '../../contexts/OnboardingContext';
import type { OnboardingContextValue } from '../../contexts/OnboardingContext';
import {
  USER_HUB_PATH,
  USER_HUB_TITLE,
  USER_SETTINGS_SECTIONS,
} from '../../config/userSettingsSections';
import { settingsPageTitle } from '../../config/adminSections';
import { AXE_OPTIONS } from '../components/home/homeFixtures';
import {
  onboardingContext,
  step,
  userState,
} from '../components/onboarding/onboardingFixtures';

const APP_TSX = resolve(dirname(fileURLToPath(import.meta.url)), '../../App.tsx');

/**
 * A Viewer holding nothing but their own settings permissions — this
 * application's DEFAULT role, and the account this page mostly serves.
 */
const viewer: MockUser = {
  ...mockUser,
  permissions: ['user_settings:read', 'user_settings:write'],
};

function renderPage(value: Partial<OnboardingContextValue> = {}, user: MockUser = viewer) {
  const context = onboardingContext({ user: userState(), ...value });
  const view = render(
    <OnboardingContext.Provider value={context}>
      <GettingStartedPage />
    </OnboardingContext.Provider>,
    { wrapperOptions: { user } },
  );
  return { ...view, context };
}

beforeEach(() => {
  mockNavigate.mockClear();
});

// =============================================================================
// The registry contract
// =============================================================================

describe('the Getting Started card (#279)', () => {
  const account = USER_SETTINGS_SECTIONS.find((section) => section.label === 'Account');
  const card = account?.cards[0];

  it('is the FIRST card in Account', () => {
    // First in the group, and Account is the first group — this is where the
    // shell banner leads, and, more importantly, where the checklist remains
    // findable after that banner has been permanently dismissed.
    expect(card?.title).toBe('Getting Started');
    expect(USER_SETTINGS_SECTIONS[0].label).toBe('Account');
  });

  it('routes to /settings/getting-started', () => {
    expect(card?.path).toBe(GETTING_STARTED_PATH);
  });

  it('declares NO permission, like every card in this registry', () => {
    // `onboarding.controller.ts` gates `GET /api/onboarding` on `@Auth()` with
    // no permission string — the resource is the caller's own state. A gate
    // here would invent an authorization rule the API does not enforce, and
    // `userSettingsSections.test.ts` asserts the same claim across the whole
    // file. Checked for ABSENCE of the key, not merely for `undefined`.
    expect('permission' in (card as object)).toBe(false);
    expect(card?.permission).toBeUndefined();
  });

  it('is routed in the live App.tsx with no RequirePermission around it', () => {
    const source = readFileSync(APP_TSX, 'utf8');
    const chunk = source
      .split('<Route')
      .slice(1)
      .find((entry) => /^\s*path="\/settings\/getting-started"/.test(entry));

    expect(chunk, '/settings/getting-started has no route in App.tsx').toBeDefined();
    expect(/permission="([^"]+)"/.exec(chunk!)).toBeNull();
  });

  it('resolves the AppBar title through settingsPageTitle', () => {
    expect(
      settingsPageTitle(
        USER_SETTINGS_SECTIONS,
        USER_HUB_PATH,
        USER_HUB_TITLE,
        GETTING_STARTED_PATH,
      ),
    ).toBe('Getting Started');
  });

  it('names the page identically to the card', () => {
    expect(PAGE_TITLE).toBe(card?.title);
    expect(PAGE_DESCRIPTION).toBe(card?.description);
  });
});

// =============================================================================
// ⚠ The BYOK explainer
// =============================================================================

describe('the BYOK explainer', () => {
  it('states all three facts: your key, your billing, no deployment key', () => {
    renderPage();

    for (const fact of BYOK_FACTS) {
      expect(screen.getByText(fact)).toBeInTheDocument();
    }

    // Each fact is separately surprising and none implies the others, so the
    // literals are pinned here as well as in the page — a silent edit that
    // dropped one would otherwise pass a test that only looked for the word
    // "key".
    expect(BYOK_FACTS).toHaveLength(3);
    expect(BYOK_FACTS[0]).toMatch(/The key is yours/);
    expect(BYOK_FACTS[1]).toMatch(/billed to your account/);
    expect(BYOK_FACTS[2]).toMatch(/stores no key of its own/);
  });

  it('renders ABOVE the checklist', () => {
    const { container } = renderPage();

    const explainer = screen.getByRole('heading', {
      level: 2,
      name: 'About AI features and your own key',
    });
    const checklist = screen.getByRole('list', { name: 'Setup steps' });

    // ⚠ Copy that has drifted below the list arrives at the same moment the
    // `AiKeyRequired` gate would have — which is the moment the task is
    // abandoned, and the whole reason this page exists.
    const position = explainer.compareDocumentPosition(checklist);
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container).toContainElement(checklist);
  });

  it('links to the page where a key is connected', () => {
    renderPage();
    expect(screen.getByRole('link', { name: 'Connect your AI provider key' })).toHaveAttribute(
      'href',
      AI_SETTINGS_PATH,
    );
  });
});

// =============================================================================
// The checklist
// =============================================================================

describe('the checklist', () => {
  it('is reachable by a Viewer holding only their own settings permissions', async () => {
    const { context } = renderPage();

    expect(screen.getByRole('heading', { level: 1, name: PAGE_TITLE })).toBeInTheDocument();
    expect(screen.getByText('Record your first conversation')).toBeInTheDocument();
    await waitFor(() => expect(context.refresh).toHaveBeenCalled());
  });

  it('appends ?setup=<stepKey> when a step’s action is taken', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(screen.getByRole('button', { name: 'New transcript' }));

    expect(mockNavigate).toHaveBeenCalledWith(
      '/transcripts/new?setup=user.first_transcript',
    );
  });

  it('offers an Undo on a skipped step and issues exactly one unskip', async () => {
    const user = userEvent.setup();
    const unskip = vi.fn().mockResolvedValue(undefined);
    renderPage({
      user: userState({
        steps: [
          step({
            key: 'user.profile',
            tier: 'optional',
            title: 'Set your display name and picture',
            actionLabel: 'Edit your profile',
            href: '/settings/profile',
            skippable: true,
            skipped: true,
          }),
        ],
      }),
      unskip,
    });

    // The reason #275 returns skipped steps rather than filtering them out: a
    // skip a user cannot reverse is a decision they made once, permanently,
    // from a row they may have clicked by accident.
    await user.click(screen.getByRole('button', { name: 'Undo skip' }));
    expect(unskip).toHaveBeenCalledTimes(1);
    expect(unskip).toHaveBeenCalledWith('user.profile');
  });

  it('explains a blocked step and offers no administrator shortcut', async () => {
    renderPage({
      user: userState({
        steps: [
          step({
            key: 'user.first_transcript',
            status: 'blocked',
            blockedReason:
              'Your administrator has not configured transcription for this deployment yet.',
          }),
        ],
      }),
    });

    expect(
      screen.getByText(
        'Your administrator has not configured transcription for this deployment yet.',
      ),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: 'New transcript' })).toBeDisabled();

    // ⚠ NOT the "Set up transcription" shortcut `NewTranscriptButton` shows an
    // administrator. An ordinary user cannot act on it, and a button that leads
    // to a 403 is worse than a sentence that explains who to ask.
    expect(
      screen.queryByRole('link', { name: /transcription settings/i }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /set up transcription/i }),
    ).not.toBeInTheDocument();
  });

  it('renders the error with a retry when the read failed outright', () => {
    renderPage({ user: null, error: 'Failed to load setup state' });
    expect(screen.getByText('Failed to load setup state')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});

// =============================================================================
// Replay the intro — the #280 seam
// =============================================================================

describe('replaying the intro', () => {
  it('offers the control, and pressing it does not clear welcomeSeenAt', async () => {
    const user = userEvent.setup();
    const { context } = renderPage({ welcomeSeen: true });

    // An intro you can only ever see once is one a user who dismissed it on
    // reflex can never get back, and this page is where they will look for it.
    const replay = screen.getByRole('button', { name: 'Replay the intro' });
    await user.click(replay);

    // ⚠ The criterion, stated as an assertion: replaying is a user asking to
    // watch something again, not the first run happening twice. Nothing about
    // the stored `onboarding` namespace may move — no write path of any kind
    // is reached. #280 replaces the handler's body with "open the dialog", and
    // this assertion is what keeps it from also reaching for a setting.
    expect(context.markWelcomeSeen).not.toHaveBeenCalled();
    expect(context.skip).not.toHaveBeenCalled();
    expect(context.unskip).not.toHaveBeenCalled();
    expect(context.dismiss).not.toHaveBeenCalled();
  });
});

// =============================================================================
// vitest-axe
// =============================================================================

describe('accessibility', () => {
  it('is clean with an outstanding checklist', async () => {
    const { container } = renderPage();
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('is clean with a blocked step', async () => {
    const { container } = renderPage({
      user: userState({
        steps: [
          step({
            key: 'user.first_transcript',
            status: 'blocked',
            blockedReason: 'Your administrator has not configured transcription yet.',
          }),
        ],
      }),
    });
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});
