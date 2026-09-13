import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { APP_NAME } from '@app/shared';
import { InstallPrompt } from '../../../components/pwa/InstallPrompt';

/**
 * Issue #219, epic #215.
 *
 * Rendered bare, matching how `App.tsx` mounts it (outside `Routes` and
 * outside `ErrorBoundary`). That also keeps the throwing-`localStorage` case
 * below honest: `ThemeContext` reads `localStorage` UNGUARDED, so a provider
 * wrapper would throw before the component under test ever rendered, and the
 * test would be asserting the wrapper's behaviour rather than this component's.
 */

const INSTALL_DISMISSED_KEY = 'pwa_install_dismissed';
const INSTALL_MESSAGE = `Install ${APP_NAME} for faster access and notifications`;

const originalMatchMedia = window.matchMedia;

/**
 * Dispatches a realistic `beforeinstallprompt`: `cancelable` so that
 * `preventDefault()` actually registers (an event created without it silently
 * ignores the call, which would make the mini-infobar assertion vacuous), and
 * carrying the `prompt()` / `userChoice` members Chromium attaches.
 *
 * Wrapped in `act` because the state update happens in a window listener, not
 * in a React event handler.
 */
function fireBeforeInstallPrompt() {
  const prompt = vi.fn<() => Promise<void>>(() => Promise.resolve());
  const event = new Event('beforeinstallprompt', { cancelable: true });
  Object.assign(event, {
    platforms: ['web'],
    prompt,
    userChoice: Promise.resolve({ outcome: 'accepted', platform: 'web' }),
  });

  act(() => {
    window.dispatchEvent(event);
  });

  return { event, prompt };
}

beforeEach(() => {
  // The setup file's localStorage mock is a module-level store shared by every
  // test in the run, so a persisted dismissal would leak into later cases.
  window.localStorage.removeItem(INSTALL_DISMISSED_KEY);
});

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: originalMatchMedia,
  });
  delete (window.navigator as Navigator & { standalone?: boolean }).standalone;
});

describe('InstallPrompt', () => {
  it('renders nothing until the browser offers an install', () => {
    // THE LOAD-BEARING CASE — see UpdatePrompt's equivalent. Most page loads
    // never see `beforeinstallprompt` (already installed, criteria not met,
    // Safari), so this idle state is the one nearly every user gets.
    const { container } = render(<InstallPrompt />);

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
  });

  it('offers installation once the browser fires beforeinstallprompt', () => {
    render(<InstallPrompt />);

    const { event } = fireBeforeInstallPrompt();

    expect(screen.getByText(INSTALL_MESSAGE)).toBeInTheDocument();
    // Suppressing Chromium's own mini-infobar is what earns the right to show
    // this instead — and it is also required before the event may be deferred.
    expect(event.defaultPrevented).toBe(true);
  });

  it('opens the native install dialog when Install is clicked', async () => {
    const user = userEvent.setup();
    render(<InstallPrompt />);
    const { prompt } = fireBeforeInstallPrompt();

    await user.click(screen.getByRole('button', { name: 'Install' }));

    expect(prompt).toHaveBeenCalledTimes(1);
    // The deferred event is single-use, so the offer must close as the native
    // dialog opens; a second click would reject against a spent event.
    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });

  it('remembers a dismissal across a remount', async () => {
    const user = userEvent.setup();
    const first = render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    await user.click(screen.getByRole('button', { name: 'Dismiss install prompt' }));
    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INSTALL_DISMISSED_KEY)).toBe('true');

    // A fresh mount is what the next page load looks like. Without the
    // persisted flag the browser would re-fire the event and the user would be
    // asked again on every visit, which is how a prompt becomes wallpaper.
    first.unmount();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });

  it('still works when localStorage throws on access', async () => {
    // Safari's private mode and a blocked-storage iframe do not return null
    // here — the accessor THROWS. An unguarded read during render would white-
    // screen the whole application for a dismissible suggestion.
    const denied = () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    };
    vi.spyOn(window.localStorage, 'getItem').mockImplementation(denied);
    vi.spyOn(window.localStorage, 'setItem').mockImplementation(denied);

    const user = userEvent.setup();
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    // The read failed, so the component correctly assumes "not yet dismissed".
    expect(screen.getByText(INSTALL_MESSAGE)).toBeInTheDocument();

    // And the write failing must not surface as an unhandled error: the
    // dismissal simply does not outlive the page.
    await user.click(screen.getByRole('button', { name: 'Dismiss install prompt' }));
    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });

  it('never offers installation when already running installed', () => {
    // `display-mode: standalone` — the signal every Chromium browser answers.
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query.includes('display-mode: standalone'),
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });

    const { container } = render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });

  it('never offers installation from inside an iOS Home Screen app', () => {
    // iOS answers `navigator.standalone` instead of the media query, so the
    // media-query check alone would offer an install inside the installed app.
    (window.navigator as Navigator & { standalone?: boolean }).standalone = true;

    render(<InstallPrompt />);
    fireBeforeInstallPrompt();

    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });

  it('withdraws the offer when the app is installed some other way', () => {
    // Chromium's omnibox install button fires `appinstalled` without ever
    // telling this component. Without that listener the offer would sit on
    // screen in the tab that is still open, inviting a second install.
    render(<InstallPrompt />);
    fireBeforeInstallPrompt();
    expect(screen.getByText(INSTALL_MESSAGE)).toBeInTheDocument();

    act(() => {
      window.dispatchEvent(new Event('appinstalled'));
    });

    expect(screen.queryByText(INSTALL_MESSAGE)).not.toBeInTheDocument();
  });
});
