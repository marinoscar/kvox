/**
 * this app's minimal binding of the platform host (issue #466, epic #462).
 *
 * The packaged Appearance and Profile pages, the headless settings hooks and
 * their own behaviour (409 refetch, `If-Match`, spinners, snackbars) are proved
 * by `@marinoscar/platform-web`'s suite. These are the cases about this app's glue,
 * ported from the deleted `UserSettingsPages.test.tsx` and `useUserSettings`
 * suites:
 *
 *   - the host's `applyTheme` is this app's `ThemeContext` setter, so the stored
 *     preference reaches the live theme when the page loads and when it is saved
 *     (acceptance criterion: "theme switching still applies live"), and a theme
 *     id this app has no theme for is ignored;
 *   - the host's `api` is this app's one transport, so a save is a real `PATCH
 *     /user-settings` carrying the loaded `version` as `If-Match`;
 *   - the Profile page renders under the host, with this app's own user.
 *
 * Over the real packaged pages and MSW: a `vi.mock` of the headless hooks cannot
 * reach the packaged pages (Vite externalises the package).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { UserAppearancePage, UserProfilePage } from '@marinoscar/platform-web/settings/ui';
import { render } from '../utils/test-utils';
import { server } from '../mocks/server';
import { useThemeContext } from '../../contexts/ThemeContext';

function ThemeProbe() {
  return <div data-testid="mode">{useThemeContext().mode}</div>;
}

interface Patch {
  body: Record<string, unknown>;
  ifMatch: string | null;
}
let patches: Patch[] = [];

function serveSettings(theme: string) {
  const doc = {
    theme,
    profile: { displayName: 'Test User', imageSource: 'provider' },
    updatedAt: new Date().toISOString(),
    version: 7,
  };
  server.use(
    http.get('*/api/user-settings', () => HttpResponse.json({ data: doc })),
    http.patch('*/api/user-settings', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push({ body, ifMatch: request.headers.get('If-Match') });
      return HttpResponse.json({ data: { ...doc, ...body, version: doc.version + 1 } });
    }),
  );
}

describe('PlatformHost (applyTheme and api)', () => {
  beforeEach(() => {
    patches = [];
    localStorage.clear();
  });

  it('applies the stored theme to the live theme context when the page loads', async () => {
    serveSettings('dark');

    render(
      <>
        <ThemeProbe />
        <UserAppearancePage />
      </>,
    );

    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('dark'));
  });

  it('applies a saved theme live, and PATCHes it with the loaded version as If-Match', async () => {
    serveSettings('light');
    const user = userEvent.setup();

    render(
      <>
        <ThemeProbe />
        <UserAppearancePage />
      </>,
    );

    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('light'));
    await user.click(await screen.findByRole('button', { name: /dark mode/i }));

    await waitFor(() => expect(patches).toHaveLength(1));
    expect(patches[0]).toEqual({ body: { theme: 'dark' }, ifMatch: '7' });
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('dark'));
  });

  it('ignores a stored theme id this app has no theme for', async () => {
    serveSettings('solarized');

    render(
      <>
        <ThemeProbe />
        <UserAppearancePage />
      </>,
    );

    await screen.findByRole('heading', { name: /appearance/i, level: 1 });
    expect(screen.getByTestId('mode')).not.toHaveTextContent('solarized');
  });

  it('renders the packaged Profile page for the signed-in user', async () => {
    serveSettings('system');

    render(<UserProfilePage />);

    expect(await screen.findByRole('heading', { name: /profile/i, level: 1 })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('Test User')).toBeInTheDocument();
  });
});
