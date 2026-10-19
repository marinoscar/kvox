/**
 * `KvoxAppShell` in a no-API local host (issue #629, acceptance criterion): the
 * platform's `LocalIdentityProvider` and `ShellPreferencesProvider` stand in for the
 * server session, and the shell draws the rail, the brand lockup, the theme toggle
 * and the user menu while making ZERO network calls.
 */

import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { LocalIdentityProvider } from '@marinoscar/platform-web/identity/headless';
import { registerSettingsFeature } from '@marinoscar/platform-web/settings/headless';
import { ShellPreferencesProvider, createLocalStorageShellPreferencesPort } from '@marinoscar/platform-web/shell/headless';
import { ShellRoot } from '@marinoscar/platform-web/shell/ui';
import { render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createKvoxTheme } from '../../src/brand/index.js';
import { setViewportWidth } from '../../src/core/testing/viewport.js';
import { KvoxAppShell, createKvoxNavigation } from '../../src/shell/index.js';

// The host's own resolver for the `graph` feature, registered once at module scope
// (the platform refuses a registration after the first render).
const graphFeature = vi.hoisted(() => ({ on: true }));
declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    graph: true;
  }
}
registerSettingsFeature('graph', () => graphFeature.on);

const THEMES = { light: createKvoxTheme('light'), dark: createKvoxTheme('dark') };
const PERMISSIONS = ['notes:read', 'graph:read'];

// Declared once at module scope, as the shell requires.
const { navigation } = createKvoxNavigation({
  include: ['notes', 'graph', 'review', 'ask', 'templates'],
  settingsPath: '/settings',
});

const DESKTOP = 1400;
const PHONE = 375;

let fetchCalls: unknown[][] = [];
const realFetch = globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  graphFeature.on = true;
  localStorage.clear();
  globalThis.fetch = ((...args: unknown[]) => {
    fetchCalls.push(args);
    return Promise.reject(new Error('a local host makes no network call'));
  }) as typeof fetch;
  setViewportWidth(DESKTOP);
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const user = userEvent.setup();

function renderShell(props: Partial<Parameters<typeof KvoxAppShell>[0]> = {}, route = '/notes') {
  const port = createLocalStorageShellPreferencesPort('kvox-shell-test');
  return render(
    <ShellRoot themes={THEMES} storageKey="kvox-shell-test-theme">
      <LocalIdentityProvider userId="local" displayName="Local Tester" permissions={PERMISSIONS}>
        <ShellPreferencesProvider port={port}>
          <MemoryRouter initialEntries={[route]}>
            <Routes>
              <Route element={<KvoxAppShell navigation={navigation} {...props} />}>
                <Route path="/notes" element={<p>notes page</p>} />
                <Route path="/graph/review" element={<p>review page</p>} />
                <Route path="/settings/*" element={<p>settings page</p>} />
              </Route>
            </Routes>
          </MemoryRouter>
        </ShellPreferencesProvider>
      </LocalIdentityProvider>
    </ShellRoot>,
  );
}

describe('KvoxAppShell in a local host', () => {
  it('draws the rail, the lockup, the theme toggle and the user menu, with no network call', async () => {
    renderShell();

    const rail = screen.getByRole('navigation', { name: 'Main navigation' });
    for (const name of ['Notes', 'Knowledge', 'Review', 'Ask', 'Templates', 'Settings']) {
      expect(within(rail).getByRole('link', { name })).toBeInTheDocument();
    }
    expect(within(rail).getByRole('link', { name: 'Notes' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('kvox-brand-mark')).toBeInTheDocument();
    expect(screen.getByText('KVox')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'toggle theme' })).toBeInTheDocument();
    expect(screen.getByText('notes page')).toBeInTheDocument();

    // The user menu has no sign-out and no organization switcher in local mode.
    await user.click(screen.getByText('LT'));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByText(/logout|sign out/i)).not.toBeInTheDocument();

    expect(fetchCalls).toEqual([]);
  });

  it('persists the rail collapse through the preferences port, not the API', async () => {
    renderShell();

    await user.click(screen.getByRole('button', { name: 'Collapse navigation' }));

    expect(await screen.findByRole('button', { name: 'Expand navigation' })).toBeInTheDocument();
    expect(localStorage.getItem('kvox-shell-test')).toContain('"railCollapsed":true');
    expect(fetchCalls).toEqual([]);
  });

  it('hides the graph-gated rows when the host feature is off', () => {
    graphFeature.on = false;
    renderShell();

    const rail = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(rail).getByRole('link', { name: 'Notes' })).toBeInTheDocument();
    for (const name of ['Knowledge', 'Review', 'Ask']) {
      expect(within(rail).queryByRole('link', { name })).not.toBeInTheDocument();
    }
  });

  it('lights Review, not Knowledge, on /graph/review', () => {
    renderShell({}, '/graph/review');

    const rail = screen.getByRole('navigation', { name: 'Main navigation' });
    expect(within(rail).getByRole('link', { name: 'Review' })).toHaveAttribute('aria-current', 'page');
    expect(within(rail).getByRole('link', { name: 'Knowledge' })).not.toHaveAttribute('aria-current');
  });

  it('adds the host user menu rows, the banners, the overlays and the actions', async () => {
    const onOpen = vi.fn();
    renderShell({
      actions: <button type="button">host action</button>,
      banners: <p>host banner</p>,
      overlays: <p>host overlay</p>,
      userMenuItems: [{ key: 'data-folder', label: 'Open data folder', onClick: onOpen }],
    });

    expect(screen.getByRole('button', { name: 'host action' })).toBeInTheDocument();
    expect(screen.getByText('host banner')).toBeInTheDocument();
    expect(screen.getByText('host overlay')).toBeInTheDocument();

    await user.click(screen.getByText('LT'));
    await user.click(await screen.findByRole('menuitem', { name: 'Open data folder' }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders the rows the host render prop returns inside the user menu', async () => {
    renderShell({ renderUserMenuItems: () => <li role="menuitem">Getting started</li> });

    await user.click(screen.getByText('LT'));
    expect(await screen.findByRole('menuitem', { name: 'Getting started' })).toBeInTheDocument();
  });

  it('can hide the theme toggle', () => {
    renderShell({ showThemeToggle: false });

    const toggle = screen.getByLabelText('toggle theme', { selector: 'button' });
    expect(getComputedStyle(toggle).display).toBe('none');
  });

  it('draws the phone bar without the pinned Settings destination', () => {
    setViewportWidth(PHONE);
    renderShell();

    expect(screen.queryByRole('navigation', { name: 'Main navigation' })).not.toBeInTheDocument();
    const labels = screen.getAllByRole('button').map((button) => button.getAttribute('aria-label'));
    expect(labels).not.toContain('Settings');
    expect(labels).toContain('Notes');
  });
});
