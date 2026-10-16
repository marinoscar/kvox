/**
 * The welcome panes in the platform `WelcomeDialog`'s two body slots (issue #481, epic #478).
 *
 * The dialog itself is the platform's (its buttons, routing and "seen" write are tested there);
 * what this suite pins is what this app owns: the three panes' copy, their order, and that the
 * packaged dialog opens with them for a user and for an administrator.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import {
  OnboardingProvider,
  type OnboardingClient,
  type OnboardingResponse,
} from '@marinoscar/platform-web/onboarding/headless';
import { WelcomeDialog } from '@marinoscar/platform-web/onboarding/ui';

import {
  BACK_LABEL,
  BYOK_DIALOG_FACTS,
  NEXT_LABEL,
  adminWelcomePane,
  userWelcomePane,
  welcomePanesFor,
} from '../../../components/onboarding/kvoxWelcomePanes';
import { ADMIN_STEPS, USER_STEPS, onboardingResponse } from './onboardingFixtures';

/** The real provider over a fake client: the packaged dialog reads the provider, not a mockable hook. */
async function renderDialog(response: OnboardingResponse) {
  const client: OnboardingClient = {
    get: vi.fn().mockResolvedValue(response),
    metrics: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
  };
  render(
    <MemoryRouter>
      <OnboardingProvider client={client} appName="Test App">
        <WelcomeDialog slots={{ userPane: userWelcomePane, adminPane: adminWelcomePane }} />
      </OnboardingProvider>
    </MemoryRouter>,
  );
  return client;
}

describe('the welcome panes', () => {
  it('are three, in order: what it does, your own key, the checklist', () => {
    for (const audience of ['user', 'admin'] as const) {
      expect(welcomePanesFor(audience).map((pane) => pane.key)).toEqual(['what', 'byok', 'checklist']);
    }
  });

  it('state all three BYOK facts by name, and the user and admin sets share the first two panes', () => {
    expect(BYOK_DIALOG_FACTS).toHaveLength(3);
    expect(BYOK_DIALOG_FACTS[0]).toMatch(/key is yours/i);
    expect(BYOK_DIALOG_FACTS[1]).toMatch(/billed to your account/i);
    expect(BYOK_DIALOG_FACTS[2]).toMatch(/no key of its own/i);

    const user = welcomePanesFor('user');
    const admin = welcomePanesFor('admin');
    expect(admin[0]).toEqual(user[0]);
    expect(admin[1]).toEqual(user[1]);
    expect(admin[2]!.title).not.toEqual(user[2]!.title);
  });

  it('open in the platform dialog for a user, walk Next and Back, and end on the checklist pane', async () => {
    await renderDialog(onboardingResponse({ user: USER_STEPS }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Step 1 of 3')).toBeInTheDocument();
    expect(within(dialog).getByText('Welcome to Test App')).toBeInTheDocument();
    // The platform's own actions: the user is sent to Get started.
    expect(within(dialog).getByRole('button', { name: 'Get started' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: BACK_LABEL })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: NEXT_LABEL }));
    expect(within(dialog).getByText('Step 2 of 3')).toBeInTheDocument();
    expect(within(dialog).getByRole('heading', { name: 'AI runs on your own provider key' })).toBeInTheDocument();
    for (const fact of BYOK_DIALOG_FACTS) expect(within(dialog).getByText(fact)).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: NEXT_LABEL }));
    expect(within(dialog).getByRole('heading', { name: 'Here is what is left to set up' })).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: NEXT_LABEL })).toBeDisabled();

    await userEvent.click(within(dialog).getByRole('button', { name: BACK_LABEL }));
    expect(within(dialog).getByText('Step 2 of 3')).toBeInTheDocument();
  });

  it('give an administrator the deployment variant of the last pane and the Setup guide action', async () => {
    await renderDialog(onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Start setup' })).toBeInTheDocument();

    await userEvent.click(within(dialog).getByRole('button', { name: NEXT_LABEL }));
    await userEvent.click(within(dialog).getByRole('button', { name: NEXT_LABEL }));
    expect(within(dialog).getByRole('heading', { name: 'Here is what this deployment still needs' })).toBeInTheDocument();
  });

  it('describe the dialog: the pane container carries the id the dialog is described by', async () => {
    await renderDialog(onboardingResponse({ user: USER_STEPS }));

    const dialog = await screen.findByRole('dialog');
    const describedBy = dialog.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)).toHaveTextContent('Step 1 of 3');
  });

  it('do not open for a user who has seen the welcome', async () => {
    const client = await renderDialog(
      onboardingResponse({ user: USER_STEPS, settings: { welcomeSeenAt: '2026-01-01T00:00:00.000Z' } }),
    );

    await vi.waitFor(() => expect(client.get).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
