/**
 * The two onboarding routes: the platform's Setup guide and Get started pages with this app's
 * content in their `BeforeContent` slots (issue #481, epic #478).
 *
 * The real `OnboardingProvider` runs over a fake client, so the packaged pages, the provider and
 * the slots are exercised together. What is pinned here is what this app adds: the AI-key
 * explanation on both pages, the inline invite for a holder of `allowlist:write` only, the
 * refresh when a page mounts, and the registry cards that lead to them.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ReactElement } from 'react';

import {
  OnboardingProvider,
  type OnboardingClient,
  type OnboardingResponse,
} from '@marinoscar/platform-web/onboarding/headless';

import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { server } from '../../mocks/server';
import GettingStartedRoute, { AI_SETTINGS_PATH, BYOK_FACTS } from '../../../components/onboarding/GettingStartedRoute';
import SetupGuideRoute, { INVITE_PERMISSION } from '../../../components/onboarding/SetupGuideRoute';
import { ADMIN_STEPS, USER_STEPS, onboardingResponse } from './onboardingFixtures';

function fakeClient(response: OnboardingResponse): OnboardingClient {
  return {
    get: vi.fn().mockResolvedValue(response),
    metrics: vi.fn(),
    write: vi.fn().mockResolvedValue(undefined),
  };
}

function withProvider(client: OnboardingClient, children: ReactElement) {
  return (
    <OnboardingProvider client={client} appName="Test App">
      {children}
    </OnboardingProvider>
  );
}

describe('GettingStartedRoute', () => {
  it('shows the platform checklist with the retired statuses and blocked reasons', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS }));
    render(withProvider(client, <GettingStartedRoute />), { wrapperOptions: { user: mockUser } });

    expect(await screen.findByText('Add your AI provider key')).toBeInTheDocument();
    expect(screen.getByText('Transcribe your first recording')).toBeInTheDocument();
    expect(screen.getByText(/Your administrator has not connected a transcription provider yet/)).toBeInTheDocument();
  });

  it('explains the three BYOK facts above the checklist and links to the key page', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS }));
    render(withProvider(client, <GettingStartedRoute />), { wrapperOptions: { user: mockUser } });

    expect(await screen.findByRole('heading', { name: 'About AI features and your own key' })).toBeInTheDocument();
    expect(BYOK_FACTS).toHaveLength(3);
    for (const fact of BYOK_FACTS) expect(screen.getByText(fact)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Connect your AI provider key' })).toHaveAttribute('href', AI_SETTINGS_PATH);
  });

  it('re-reads the checklist when it mounts, since the provider reads once and never polls', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS }));
    render(withProvider(client, <GettingStartedRoute />), { wrapperOptions: { user: mockUser } });

    await screen.findByText('Add your AI provider key');
    // One read on the provider's mount, one when the page mounts.
    await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
  });

  it('skips a skippable step through the platform action', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS }));
    render(withProvider(client, <GettingStartedRoute />), { wrapperOptions: { user: mockUser } });

    await screen.findByText('Generate your first note');
    await userEvent.click(screen.getByRole('button', { name: /skip/i }));

    await waitFor(() => expect(client.write).toHaveBeenCalledWith({ skipped: ['user.first_note'] }));
  });
});

describe('SetupGuideRoute', () => {
  beforeEach(() => {
    server.use(
      http.get('*/api/admin/onboarding/metrics', () =>
        HttpResponse.json({
          data: { windowDays: 30, cohortSize: 0, milestones: [], steps: [] },
          meta: { timestamp: '2026-01-01T00:00:00.000Z' },
        }),
      ),
    );
  });

  it('shows the deployment checklist and the user-owned-keys explanation', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }));
    render(withProvider(client, <SetupGuideRoute />), { wrapperOptions: { user: mockAdminUser } });

    expect(await screen.findByText('Connect a transcription provider')).toBeInTheDocument();
    expect(screen.getByText('Transcribe a test recording')).toBeInTheDocument();
    expect(screen.getByText(/Connect a transcription provider first/)).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'AI keys belong to each user, not to this deployment' })).toBeInTheDocument();
  });

  it('offers the inline invite to a holder of allowlist:write, and only to them', async () => {
    expect(mockAdminUser.permissions).toContain(INVITE_PERMISSION);
    const client = fakeClient(onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }));

    const { unmount } = render(withProvider(client, <SetupGuideRoute />), { wrapperOptions: { user: mockAdminUser } });
    expect(await screen.findByRole('button', { name: 'Invite by email' })).toBeInTheDocument();
    unmount();

    const readOnly = { ...mockAdminUser, permissions: mockAdminUser.permissions.filter((p) => p !== INVITE_PERMISSION) };
    render(withProvider(client, <SetupGuideRoute />), { wrapperOptions: { user: readOnly } });
    await screen.findByText('Connect a transcription provider');
    expect(screen.queryByRole('button', { name: 'Invite by email' })).not.toBeInTheDocument();
  });

  it('re-reads the checklist when it mounts', async () => {
    const client = fakeClient(onboardingResponse({ user: USER_STEPS, admin: ADMIN_STEPS }));
    render(withProvider(client, <SetupGuideRoute />), { wrapperOptions: { user: mockAdminUser } });

    await screen.findByText('Connect a transcription provider');
    await waitFor(() => expect(client.get).toHaveBeenCalledTimes(2));
  });
});

describe('the registry cards', () => {
  it('lead to the two routes, under the permissions the API enforces', async () => {
    const { ADMIN_SECTIONS } = await import('../../../config/adminSections');
    const { USER_SETTINGS_SECTIONS } = await import('../../../config/userSettingsSections');

    const setup = ADMIN_SECTIONS.flatMap((s) => s.cards).find((c) => c.path === '/admin/settings/setup');
    expect(setup).toMatchObject({ title: 'Setup guide', permission: 'system_settings:read' });
    // First in the first group: on minute one, "what do I do first" is the first thing in the hub.
    expect(ADMIN_SECTIONS[0]!.cards[0]!.path).toBe('/admin/settings/setup');

    const started = USER_SETTINGS_SECTIONS.flatMap((s) => s.cards).find((c) => c.path === '/settings/getting-started');
    expect(started).toMatchObject({ title: 'Getting started' });
    // Every role holds `user_settings:read`, the only permission the route needs: no card gate.
    expect(started).not.toHaveProperty('permission');
    expect(USER_SETTINGS_SECTIONS[0]!.cards[0]!.path).toBe('/settings/getting-started');
  });
});
