import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UpdatePrompt } from '../../../components/pwa/UpdatePrompt';
import {
  resetRegisterSWMock,
  setRegisterSWState,
  updateServiceWorkerMock,
} from '../../mocks/pwa-register';

/**
 * Issue #219, epic #215.
 *
 * `virtual:pwa-register/react` is not mocked here with `vi.mock()`: it is
 * aliased to `src/__tests__/mocks/pwa-register.ts` in `vitest.config.ts`,
 * because the specifier does not resolve at all without the alias (the module
 * is synthesised by `VitePWA()` at build time). That double is what
 * `setRegisterSWState` below drives.
 *
 * The component is rendered BARE — no router, no auth, no theme provider —
 * deliberately, because that is how `App.tsx` mounts it: outside `Routes` and
 * outside `ErrorBoundary`, since it owns the service-worker registration and
 * must run on `/login` as much as anywhere else. Wrapping it in providers here
 * would be testing a mount that does not exist.
 */

beforeEach(() => {
  resetRegisterSWMock();
});

describe('UpdatePrompt', () => {
  it('renders nothing at all when no update is waiting', () => {
    // THE LOAD-BEARING CASE. This component is mounted on every route, so if
    // its idle state were a hidden element or an empty Snackbar rather than
    // `null`, every page in the app would gain a stray node — and the
    // visual-regression suite (maxDiffPixels: 4) would be measuring a layout
    // that no longer matches the baselines.
    const { container } = render(<UpdatePrompt />);

    expect(container).toBeEmptyDOMElement();
    // MUI portals a Snackbar to document.body, so an empty container is not on
    // its own proof that nothing was rendered.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/new version/i)).not.toBeInTheDocument();
  });

  it('announces a waiting update', () => {
    setRegisterSWState({ needRefresh: true });

    render(<UpdatePrompt />);

    expect(screen.getByText('A new version is available')).toBeInTheDocument();
    // MUI's SnackbarContent carries role="alert", which is what makes the
    // message reach a screen reader without stealing focus from the page.
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('hands over to the waiting worker and reloads when Reload is clicked', async () => {
    const user = userEvent.setup();
    setRegisterSWState({ needRefresh: true });

    render(<UpdatePrompt />);
    await user.click(screen.getByRole('button', { name: 'Reload' }));

    // `true` is the whole point: it posts SKIP_WAITING to the waiting worker
    // (which `src/sw.ts` answers) AND reloads the page once it has taken
    // control. Called without it, the user clicks Reload and nothing happens.
    expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
  });

  it('lets the user dismiss the update notice without reloading', async () => {
    const user = userEvent.setup();
    setRegisterSWState({ needRefresh: true });

    render(<UpdatePrompt />);
    await user.click(screen.getByRole('button', { name: 'Dismiss update notice' }));

    expect(screen.queryByText('A new version is available')).not.toBeInTheDocument();
    expect(updateServiceWorkerMock).not.toHaveBeenCalled();
  });

  it('confirms offline readiness without offering a reload', () => {
    // The offline confirmation is an FYI about something that already
    // succeeded — there is nothing to reload into, so a Reload button here
    // would be a button that does nothing useful.
    setRegisterSWState({ offlineReady: true });

    render(<UpdatePrompt />);

    expect(screen.getByText('Ready to work offline')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reload' })).not.toBeInTheDocument();
  });
});
