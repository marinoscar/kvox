/**
 * `OnboardingProvider` — issue #276, epic #271.
 *
 * Over the REAL `useUserSettings` and MSW rather than a mocked hook, because
 * the thing most likely to be wrong here is the WIRING: which of the two routes
 * is asked for whom, that exactly one PATCH goes out per intent and touches
 * only one namespace, and that a failed read degrades to nothing. A mocked
 * settings hook asserts none of it — it would make the `If-Match` handling, the
 * one-PATCH rule and the 409 path all invisible.
 *
 * The four properties this file exists to pin, each with the failure it
 * prevents:
 *
 *   1. A VIEWER NEVER TOUCHES `/api/admin/onboarding`. Otherwise every
 *      non-admin session buys a guaranteed 403, on every deployment, forever.
 *   2. ONE PATCH PER INTENT, `onboarding` AND NOTHING ELSE. Otherwise a
 *      dismissal quietly rewrites a namespace the user never opened.
 *   3. A FAILED READ RENDERS NOTHING. Otherwise an optional checklist's 500
 *      becomes an error banner on every page of the shell.
 *   4. NO TIMER, EVER. Asserted against this file's own SOURCE, because the
 *      absence of a poll is not observable from behaviour in a test that runs
 *      for forty milliseconds.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse, delay } from 'msw';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { server } from '../mocks/server';
import { render, mockAdminUser, mockUser } from '../utils/test-utils';
import {
  OnboardingProvider,
  applySkipOverlay,
  useOnboarding,
  ONBOARDING_ADMIN_PERMISSION,
} from '../../contexts/OnboardingContext';
import { ADMIN_ONBOARDING_PATH, ONBOARDING_PATH } from '../../services/onboarding';
import { adminState, step, userState } from '../components/onboarding/onboardingFixtures';

const API_BASE = 'http://localhost:3000/api';

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTEXT_SOURCE = resolve(HERE, '../../contexts/OnboardingContext.tsx');

/** Every request this render made, as `METHOD /path`. */
let requests: string[] = [];
/** Every PATCH body sent to `/api/user-settings`. */
let patchBodies: Record<string, unknown>[] = [];

/**
 * ⚠ THIS FILE'S ONE AND ONLY REQUEST OBSERVER, registered once at module scope
 * and never torn down — the discipline `HomePage.test.tsx`'s header spells out.
 * A second listener removed in a `finally` would remove EVERY listener on the
 * shared server, including this one, and every later assertion in this file
 * would pass vacuously against an empty array.
 */
server.events.on('request:start', ({ request }) => {
  requests.push(`${request.method} ${new URL(request.url).pathname}`);
});

function count(entry: string): number {
  return requests.filter((r) => r === entry).length;
}

const USER_SETTINGS = {
  theme: 'system',
  profile: { displayName: null, imageSource: 'provider', imageObjectId: null },
  updatedAt: '2024-03-01T09:00:00.000Z',
  version: 1,
};

function installHandlers(options: { onboarding?: Record<string, unknown> } = {}) {
  const settings = options.onboarding
    ? { ...USER_SETTINGS, onboarding: options.onboarding }
    : USER_SETTINGS;

  server.use(
    http.get(`${API_BASE}${ONBOARDING_PATH}`, () => HttpResponse.json({ data: userState() })),
    http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () =>
      HttpResponse.json({ data: adminState() }),
    ),
    http.get(`${API_BASE}/user-settings`, () => HttpResponse.json({ data: settings })),
    http.patch(`${API_BASE}/user-settings`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patchBodies.push(body);
      return HttpResponse.json({
        data: { ...settings, ...body, version: settings.version + 1 },
      });
    }),
  );
}

/**
 * A probe that renders the context as text.
 *
 * Deliberately not `renderHook`: the provider's own consumers are components
 * inside it, and rendering one is what proves the value is reachable through
 * the context rather than merely returned by a function.
 */
function Probe() {
  const onboarding = useOnboarding();
  if (!onboarding) return <div data-testid="no-provider" />;

  return (
    <div>
      <div data-testid="loading">{String(onboarding.isLoading)}</div>
      <div data-testid="error">{onboarding.error ?? ''}</div>
      <div data-testid="user">{onboarding.user ? onboarding.user.audience : 'none'}</div>
      <div data-testid="admin">{onboarding.admin ? onboarding.admin.audience : 'none'}</div>
      <div data-testid="user-remaining">{onboarding.user?.totalRemaining ?? -1}</div>
      <div data-testid="user-skipped">
        {(onboarding.user?.steps ?? [])
          .filter((s) => s.skipped)
          .map((s) => s.key)
          .join(',')}
      </div>
      <div data-testid="welcome-seen">{String(onboarding.welcomeSeen)}</div>
      <div data-testid="dismissed">
        {`${onboarding.dismissed.user}/${onboarding.dismissed.admin}`}
      </div>
      <button onClick={() => void onboarding.refresh()}>refresh</button>
      <button onClick={() => void onboarding.dismiss('user')}>dismiss-user</button>
      <button onClick={() => void onboarding.dismiss('admin')}>dismiss-admin</button>
      <button onClick={() => void onboarding.skip('user.profile')}>skip</button>
      <button onClick={() => void onboarding.unskip('user.profile')}>unskip</button>
      <button onClick={() => void onboarding.markWelcomeSeen()}>welcome</button>
    </div>
  );
}

function renderProvider(user = mockAdminUser) {
  return render(
    <OnboardingProvider>
      <Probe />
    </OnboardingProvider>,
    { wrapperOptions: { user } },
  );
}

/** Both reads and the settings read have settled. */
async function settled() {
  await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
}

beforeEach(() => {
  requests = [];
  patchBodies = [];
  installHandlers();
});

// =============================================================================
// 1. Which routes are asked, and for whom
// =============================================================================

describe('the admin gate', () => {
  it('reads both checklists for a holder of system_settings:read, once each', async () => {
    renderProvider(mockAdminUser);
    await settled();

    expect(count(`GET /api${ONBOARDING_PATH}`)).toBe(1);
    expect(count(`GET /api${ADMIN_ONBOARDING_PATH}`)).toBe(1);
    expect(screen.getByTestId('user')).toHaveTextContent('user');
    expect(screen.getByTestId('admin')).toHaveTextContent('admin');
  });

  it('never asks for the admin checklist on behalf of a Viewer', async () => {
    // ⚠ THE LOAD-BEARING CASE. `mockUser` is the default Viewer — no
    // `system_settings:read` — and for them `/api/admin/onboarding` is a
    // guaranteed 403. Asserted by REQUEST COUNT, not by inspecting the body:
    // a provider that asked and swallowed the 403 would render identically.
    expect(mockUser.permissions).not.toContain(ONBOARDING_ADMIN_PERMISSION);

    renderProvider(mockUser);
    await settled();

    expect(count(`GET /api${ONBOARDING_PATH}`)).toBe(1);
    expect(count(`GET /api${ADMIN_ONBOARDING_PATH}`)).toBe(0);
    expect(screen.getByTestId('admin')).toHaveTextContent('none');
  });

  it('gates on the exact string the admin controller enforces', () => {
    // Settings UI Pattern rule 3's discipline, applied to a fetch decision:
    // never invented, never approximated. #275 reuses `system_settings:read`
    // rather than inventing `onboarding:read`.
    const controller = readFileSync(
      resolve(HERE, '../../../../api/src/onboarding/admin-onboarding.controller.ts'),
      'utf8',
    );
    expect(controller).toContain('SYSTEM_SETTINGS_READ');
    expect(ONBOARDING_ADMIN_PERMISSION).toBe('system_settings:read');
  });
});

// =============================================================================
// 2. Refresh is the only thing that refetches
// =============================================================================

describe('refresh', () => {
  it('re-reads both checklists, and nothing else does', async () => {
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'refresh' }));

    await waitFor(() => expect(count(`GET /api${ONBOARDING_PATH}`)).toBe(2));
    expect(count(`GET /api${ADMIN_ONBOARDING_PATH}`)).toBe(2);
  });

  it('still asks for only the user checklist on a refresh by a Viewer', async () => {
    const user = userEvent.setup();
    renderProvider(mockUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'refresh' }));

    await waitFor(() => expect(count(`GET /api${ONBOARDING_PATH}`)).toBe(2));
    expect(count(`GET /api${ADMIN_ONBOARDING_PATH}`)).toBe(0);
  });
});

// =============================================================================
// 3. A failed read degrades to nothing
// =============================================================================

describe('a failed read', () => {
  it('leaves the state null rather than raising anything a shell would render', async () => {
    server.use(
      http.get(`${API_BASE}${ONBOARDING_PATH}`, () =>
        HttpResponse.json({ message: 'Boom' }, { status: 500 }),
      ),
    );

    renderProvider(mockAdminUser);
    await settled();

    // `null`, which every consumer renders as nothing. The message is exposed
    // for a PAGE to use in its own body — never for the shell.
    expect(screen.getByTestId('user')).toHaveTextContent('none');
    expect(screen.getByTestId('error').textContent).not.toBe('');
  });

  it('keeps the other checklist when only one of the two fails', async () => {
    // `Promise.allSettled`, not `Promise.all`: an administrator whose
    // DEPLOYMENT checklist 500s should still be shown their own.
    server.use(
      http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () =>
        HttpResponse.json({ message: 'Boom' }, { status: 500 }),
      ),
    );

    renderProvider(mockAdminUser);
    await settled();

    expect(screen.getByTestId('user')).toHaveTextContent('user');
    expect(screen.getByTestId('admin')).toHaveTextContent('none');
  });
});

// =============================================================================
// 4. Writes — one PATCH each, `onboarding` and nothing else
// =============================================================================

describe('writes', () => {
  it('dismisses the user surface with one PATCH touching only `onboarding`', async () => {
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'dismiss-user' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(count('PATCH /api/user-settings')).toBe(1);
    // ⚠ ONLY the one namespace. A body that also carried `theme` or `profile`
    // would be rewriting settings the user never opened.
    expect(Object.keys(patchBodies[0])).toEqual(['onboarding']);
    expect(Object.keys(patchBodies[0].onboarding as object)).toEqual(['dismissedAt']);
    await waitFor(() =>
      expect(screen.getByTestId('dismissed')).toHaveTextContent('true/false'),
    );
  });

  it('records the admin dismissal against its own timestamp', async () => {
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'dismiss-admin' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    // TWO TIMESTAMPS, NOT ONE FLAG (#272): an administrator is also a user, and
    // putting the deployment banner away must not put their own checklist away.
    expect(Object.keys(patchBodies[0].onboarding as object)).toEqual(['adminDismissedAt']);
    await waitFor(() =>
      expect(screen.getByTestId('dismissed')).toHaveTextContent('false/true'),
    );
  });

  it('records a skip as a whole replacement list, in one PATCH', async () => {
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'skip' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ onboarding: { skipped: ['user.profile'] } });
  });

  it('un-skips by sending the remaining list, in one PATCH', async () => {
    installHandlers({ onboarding: { skipped: ['user.profile'] } });
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'unskip' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(patchBodies[0]).toEqual({ onboarding: { skipped: [] } });
  });

  it('marks the welcome seen once and does not re-stamp it', async () => {
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'welcome' }));

    await waitFor(() => expect(patchBodies).toHaveLength(1));
    expect(Object.keys(patchBodies[0].onboarding as object)).toEqual(['welcomeSeenAt']);
    await waitFor(() => expect(screen.getByTestId('welcome-seen')).toHaveTextContent('true'));

    // A second call must not overwrite the first-run instant the timestamp
    // exists to record.
    await user.click(screen.getByRole('button', { name: 'welcome' }));
    expect(patchBodies).toHaveLength(1);
  });

  it('does not re-send a skip for a key already skipped', async () => {
    installHandlers({ onboarding: { skipped: ['user.profile'] } });
    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    await user.click(screen.getByRole('button', { name: 'skip' }));

    expect(patchBodies).toHaveLength(0);
  });

  it('applies the skip optimistically, before the write lands', async () => {
    // The PATCH is held open, so what is asserted below is the OVERLAY and not
    // the response. Without it the row would not visibly move for a whole round
    // trip and the progress line would lag behind the list the user is reading.
    server.use(
      http.patch(`${API_BASE}/user-settings`, async () => {
        await delay('infinite');
        return HttpResponse.json({});
      }),
    );

    const user = userEvent.setup();
    renderProvider(mockAdminUser);
    await settled();

    // Two steps, neither satisfied nor skipped.
    expect(screen.getByTestId('user-remaining')).toHaveTextContent('2');

    await user.click(screen.getByRole('button', { name: 'skip' }));

    await waitFor(() =>
      expect(screen.getByTestId('user-skipped')).toHaveTextContent('user.profile'),
    );
    // And the count is recomputed with it — the rule the DTO documents, applied
    // to the pending write.
    expect(screen.getByTestId('user-remaining')).toHaveTextContent('1');
  });
});

// =============================================================================
// 5. applySkipOverlay — the pure derivation
// =============================================================================

describe('applySkipOverlay', () => {
  it('returns the very same object when nothing changes', () => {
    const state = userState();
    // Identity, not equality. A fresh object every render would hand every
    // consumer a new context value on every tick.
    expect(applySkipOverlay(state, [])).toBe(state);
  });

  it('counts a newly skipped required step out of both remaining counts', () => {
    const state = userState({
      steps: [
        step({ key: 'a', tier: 'required', skippable: true }),
        step({ key: 'b', tier: 'recommended', skippable: true }),
      ],
    });
    expect(state.requiredRemaining).toBe(1);

    const overlaid = applySkipOverlay(state, ['a'])!;

    expect(overlaid.requiredRemaining).toBe(0);
    expect(overlaid.totalRemaining).toBe(1);
    expect(overlaid.allRequiredSatisfied).toBe(true);
  });

  it('counts an un-skipped step back in', () => {
    const state = userState({
      steps: [step({ key: 'a', tier: 'required', skippable: true, skipped: true })],
      requiredRemaining: 0,
      totalRemaining: 0,
      allRequiredSatisfied: true,
    });

    const overlaid = applySkipOverlay(state, [])!;

    expect(overlaid.requiredRemaining).toBe(1);
    expect(overlaid.allRequiredSatisfied).toBe(false);
  });

  it('never counts a satisfied step as remaining, skipped or not', () => {
    const state = userState({
      steps: [step({ key: 'a', status: 'satisfied', skippable: true })],
    });
    expect(applySkipOverlay(state, ['a'])!.totalRemaining).toBe(0);
  });

  it('passes a null state straight through', () => {
    expect(applySkipOverlay(null, ['a'])).toBeNull();
  });
});

// =============================================================================
// 6. No polling — asserted against the source
// =============================================================================

describe('the no-polling rule', () => {
  it('contains no timer, interval or polling hook whatsoever', () => {
    // ⚠ A SOURCE ASSERTION ON PURPOSE. The absence of a poll is not observable
    // from behaviour in a test that runs for forty milliseconds, and the cost
    // of a regression is a request every few seconds on the tab most likely to
    // be left open all day, on every page of the shell, forever.
    const source = readFileSync(CONTEXT_SOURCE, 'utf8');
    // The header prose names these APIs to explain why they are absent, so the
    // comments are stripped before the search — otherwise this test could only
    // be satisfied by a file that does not explain itself.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');

    for (const forbidden of [
      'setInterval',
      'setTimeout',
      'useVisiblePolling',
      'pollIntervalMs',
      'requestAnimationFrame',
    ]) {
      expect(code).not.toContain(forbidden);
    }
  });
});

describe('useOnboarding outside a provider', () => {
  it('returns null rather than throwing', () => {
    // `useNotifications`' position, for `useNotifications`' reason: a shell
    // that refuses to render because an OPTIONAL data provider is absent turns
    // a missing checklist into a blank application.
    render(<Probe />);
    expect(screen.getByTestId('no-provider')).toBeInTheDocument();
  });
});
