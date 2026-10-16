import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, screen } from '@testing-library/react';
import { render, mockUser } from '../../utils/test-utils';
import { setViewportWidth } from '../../setup';
import { Layout } from '../../../components/common/Layout';

/**
 * `Layout` is a thin binding of the packaged `ShellLayout` since issue #484
 * (epic #478), so this suite is about the BINDING, not the chrome:
 *
 *   - **exactly one navigation surface at every width.** The rail's `up('sm')`
 *     gate and the bottom bar's `down('sm')` gate are the package's hand-kept
 *     complements; walking the exact pixels either side of 600 here is how this
 *     app notices a package upgrade that drifts them;
 *   - the slots: the AppBar gets this app's navigation, the bottom bar gets the
 *     NON-PINNED one (`KVOX_BOTTOM_BAR_NAVIGATION`), the banners sit above the
 *     page and the welcome dialog is mounted.
 *
 * The AppBar and the bottom bar are replaced by markers (they need a session and
 * the rail preference's network read; the package proves them). The rail is the
 * package's real one, found by its landmark, and `ShellLayout` is real, so the
 * gates under test are the shipped ones.
 */

vi.mock('@marinoscar/platform-web/shell/ui', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/shell/ui')>()),
  ShellAppBar: vi.fn(() => <div data-testid="mock-appbar" />),
  ShellBottomNav: vi.fn(() => <div data-testid="mock-bottom-nav" />),
}));

// Issue #365. Mocked so this file can assert the banner mounts and is wired
// to the hook's own `requestPermission`/`isRequestingPermission`, without
// re-deriving the auto-prompt/boot-sync behaviour the platform slice owns
// (`@marinoscar/platform-web/notifications/headless`, #470).
vi.mock('@marinoscar/platform-web/notifications/headless', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@marinoscar/platform-web/notifications/headless')>()),
  usePushSubscriptionSync: vi.fn(),
}));

import { ShellAppBar, ShellBottomNav } from '@marinoscar/platform-web/shell/ui';
import { KVOX_BOTTOM_BAR_NAVIGATION, KVOX_NAVIGATION } from '../../../config/shell';
import { Route, Routes } from 'react-router-dom';
import { usePushSubscriptionSync } from '@marinoscar/platform-web/notifications/headless';

const mockUsePushSubscriptionSync = vi.mocked(usePushSubscriptionSync);

/** The pre-#365 shape: nothing to show, so every existing test below keeps
 *  seeing no banner unless it opts in to a different mock. */
function mockPushSyncHidden() {
  mockUsePushSubscriptionSync.mockReturnValue({
    config: null,
    capability: 'unsupported',
    requestPermission: vi.fn(),
    isRequestingPermission: false,
  });
}

/** The package rail's landmark: present at `sm` and up only (gate 1). */
function rail(): HTMLElement | null {
  return screen.queryByRole('navigation', { name: 'Main navigation' });
}

/**
 * `Layout` is a route element (the package's `ShellLayout` renders `<Outlet />`
 * inside `<main>`), so it is rendered as one, with a marker for the routed page.
 */
function LayoutRoute() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<div data-testid="outlet-content">Page Content</div>} />
      </Route>
    </Routes>
  );
}

/** Renders at `px`, driving the query-aware matchMedia mock. */
function renderAt(px: number) {
  setViewportWidth(px);
  return render(<LayoutRoute />);
}

/**
 * The emotion rules emitted for `element`, joined into one string.
 *
 * Needed because jsdom's getComputedStyle ignores `@media` blocks entirely, so
 * a responsive `sx` value cannot be read back off the element.
 */
function emittedRulesFor(element: Element): string {
  const emotionClass = [...element.classList].find((name) => name.startsWith('css-'));
  expect(emotionClass, 'element carries no emotion class').toBeDefined();

  return [...document.querySelectorAll('style')]
    .map((style) => style.textContent ?? '')
    .join('')
    .split('}}')
    .filter((block) => block.includes(`.${emotionClass}{`))
    .join('}}');
}

const PHONE = 375;
const TABLET = 800;
const DESKTOP = 1400;

describe('Layout', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    mockPushSyncHidden();
  });

  describe('Exactly one navigation surface', () => {
    it.each([
      ['phone', PHONE, true],
      ['tablet', TABLET, false],
      ['desktop', DESKTOP, false],
    ])('mounts one surface and only one at %s width', (_label, width, phone) => {
      renderAt(width);

      expect(screen.queryByTestId('mock-bottom-nav') !== null).toBe(phone);
      expect(rail() !== null).toBe(!phone);
    });

    it('never mounts both, and never mounts neither, across the sm boundary', async () => {
      // Walks the exact pixels either side of 600 — the seam where a drifted
      // gate would show up and nowhere else.
      renderAt(PHONE);

      for (const width of [375, 599, 600, 601, 900, 1200, 1400]) {
        await act(async () => setViewportWidth(width));

        const surfaces = [rail(), screen.queryByTestId('mock-bottom-nav')].filter(Boolean);

        expect(surfaces, `${width}px should have exactly one navigation surface`).toHaveLength(1);
      }
    });

    it('swaps the bottom bar for the rail at exactly 600px', async () => {
      // 600 is Material 3's compact/medium boundary. At 599 a phone treatment;
      // at 600 a tablet in portrait gets the rail rather than a phone bar.
      renderAt(599);
      expect(screen.getByTestId('mock-bottom-nav')).toBeInTheDocument();

      await act(async () => setViewportWidth(600));
      expect(rail()).toBeInTheDocument();
      expect(screen.queryByTestId('mock-bottom-nav')).not.toBeInTheDocument();
    });
  });

  describe('Main content area', () => {
    it('renders the Outlet inside a <main> element', () => {
      renderAt(DESKTOP);

      const main = screen.getByTestId('outlet-content').closest('main');
      expect(main).toBeInTheDocument();
    });

    it('sets minWidth: 0 on <main>', () => {
      // Load-bearing: a flex item's min-width defaults to `auto` (its
      // min-content width), so without this a wide descendant — a DataTable,
      // a long unbroken string — widens the whole shell past the viewport.
      renderAt(DESKTOP);

      const main = screen.getByTestId('outlet-content').closest('main')!;
      expect(getComputedStyle(main).minWidth).toBe('0px');
    });

    it('sets minWidth: 0 on the flex row that holds the rail and main', () => {
      renderAt(DESKTOP);

      const row = screen.getByTestId('outlet-content').closest('main')!.parentElement!;
      expect(getComputedStyle(row).display).toBe('flex');
      expect(getComputedStyle(row).minWidth).toBe('0px');
    });

    it('clears the fixed bottom bar below sm and drops that padding at sm', () => {
      // Asserted against the EMITTED RULES rather than getComputedStyle: jsdom
      // does not evaluate `@media` conditions, so a computed read would report
      // whichever rule happened to be last and silently pass either way. The
      // rules are also the thing the invariant is actually about — the `sm` in
      // this pb must be the same 600px the bottom bar gates on, or the padding
      // outlives the bar it was clearing.
      renderAt(PHONE);

      const main = screen.getByTestId('outlet-content').closest('main')!;
      const rules = emittedRulesFor(main);

      // pb: 10 → 80px, which clears the fixed bottom bar's height.
      expect(rules).toMatch(/@media \(min-width:0px\)\{[^}]*padding-bottom:80px/);
      // pb: 3 → 24px at sm and up, matching the other three sides.
      expect(rules).toMatch(/@media \(min-width:600px\)\{[^}]*padding-bottom:24px/);
    });
  });

  describe('Shell', () => {
    it('binds the AppBar to this app\'s navigation, with the bell and the user menu slots', () => {
      renderAt(DESKTOP);

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      const props = vi.mocked(ShellAppBar).mock.calls[0][0];
      expect(props.navigation).toBe(KVOX_NAVIGATION);
      expect(props.actions).toBeDefined();
      expect(props.userMenu).toBeDefined();
    });

    it('binds the bottom bar to the NON-PINNED navigation, never the full one (#484)', () => {
      // The package draws pinned destinations on the bar and overflows into "More";
      // this app's rule is that a mode is never a peer on the phone bar.
      renderAt(PHONE);

      const props = vi.mocked(ShellBottomNav).mock.calls[0][0];
      expect(props.navigation).toBe(KVOX_BOTTOM_BAR_NAVIGATION);
      expect(props.navigation).not.toBe(KVOX_NAVIGATION);
      expect(props.navigation.destinations.some((d) => d.pinned)).toBe(false);
    });

    it('owns viewport height so pages do not have to', () => {
      const { container } = renderAt(DESKTOP);

      const shell = container.firstChild as HTMLElement;
      expect(getComputedStyle(shell).minHeight).toBe('100vh');
      expect(getComputedStyle(shell).flexDirection).toBe('column');
    });
  });

  describe('Notification permission banner (#365)', () => {
    it('renders the banner, fed by usePushSubscriptionSync, above the Outlet', () => {
      mockUsePushSubscriptionSync.mockReturnValue({
        config: { browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BKey123' },
        capability: 'default',
        requestPermission: vi.fn(),
        isRequestingPermission: false,
      });

      renderAt(DESKTOP);

      expect(
        screen.getByText(/notifications are not enabled on this device/i),
      ).toBeInTheDocument();
    });

    it('wires the Enable button to the hook\'s own requestPermission', async () => {
      const requestPermission = vi.fn();
      mockUsePushSubscriptionSync.mockReturnValue({
        config: { browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BKey123' },
        capability: 'default',
        requestPermission,
        isRequestingPermission: false,
      });

      renderAt(DESKTOP);

      await act(async () => {
        screen.getByRole('button', { name: /enable notifications/i }).click();
      });

      expect(requestPermission).toHaveBeenCalledTimes(1);
    });

    it('renders nothing when the hook reports nothing to do (the common case, e.g. granted)', () => {
      mockUsePushSubscriptionSync.mockReturnValue({
        config: { browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BKey123' },
        capability: 'granted',
        requestPermission: vi.fn(),
        isRequestingPermission: false,
      });

      renderAt(DESKTOP);

      expect(
        screen.queryByText(/notifications are not enabled on this device/i),
      ).not.toBeInTheDocument();
    });
  });

  describe('Integration', () => {
    it('renders for an authenticated user', () => {
      setViewportWidth(DESKTOP);
      render(<LayoutRoute />, { wrapperOptions: { authenticated: true, user: mockUser } });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });

    it.each([['light'], ['dark']] as const)('renders with the %s theme', (theme) => {
      setViewportWidth(DESKTOP);
      localStorage.setItem('theme_mode', theme);
      render(<LayoutRoute />, { wrapperOptions: { theme } });

      expect(screen.getByTestId('mock-appbar')).toBeInTheDocument();
      expect(screen.getByTestId('outlet-content')).toBeInTheDocument();
    });
  });
});
