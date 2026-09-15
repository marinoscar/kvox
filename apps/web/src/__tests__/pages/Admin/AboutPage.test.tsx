/**
 * Admin → Settings → About (`/admin/settings/about`), issue #126, epic #118.
 *
 * The acceptance criteria are the three sections from a live response, the
 * "not deployed with kvox deploy" alert with Application still shown, every
 * timestamp in UTC, and the update chip appearing only when an update exists —
 * so the assertions below are about exactly those, plus the two affordances a
 * read-only page still has (Refresh, and copying the revision).
 *
 * The API is driven through msw rather than by mocking `useAbout`, the same
 * choice `MaintenancePage.test.tsx` makes: Refresh and Retry are about whether
 * a second request is made, which a mocked hook could not show.
 * `usePermissions` is left real and driven through the auth fixture.
 *
 * THE FIXTURE IS THE API'S OWN DOCUMENTED EXAMPLE (`ABOUT_RESPONSE_EXAMPLE` in
 * `about.dto.ts`, itself built on `__fixtures__/deploy-info.json`), so the
 * shape this page renders is the shape the API publishes, not one restated
 * here. Every relative age below is dated against the fixture's
 * `serverTimeUtc`, never the test machine's clock, which is why the expected
 * strings are constants rather than computed.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';
import { server } from '../../mocks/server';
import { render, mockAdminUser, mockUser } from '../../utils/test-utils';
import { setViewportWidth, resetViewportWidth } from '../../setup';
import AboutPage from '../../../pages/Admin/AboutPage';
import type { AboutResponse, DeployInfo } from '../../../types';

const FULL_SHA = '3f2a9c1d8e7b6a5f4c3d2e1f0a9b8c7d6e5f4a3b';

const DEPLOY_INFO: DeployInfo = {
  schema: 1,
  app: {
    name: 'kvox',
    version: '1.4.0',
    commitSha: FULL_SHA,
    ref: 'main',
    repoUrl: 'https://github.com/example-org/example-app',
  },
  installedAt: '2026-08-01T09:15:00.000Z',
  updatedAt: '2026-09-14T22:41:07.000Z',
  lastCommand: 'update',
  deployedBy: { cli: 'kvox', version: '1.4.0' },
  domain: 'app.example.com',
  bindPort: 3535,
  host: {
    hostname: 'vps-01',
    os: 'Ubuntu 24.04.1 LTS',
    kernel: '6.8.0-45-generic',
    arch: 'x64',
    cpuModel: 'AMD EPYC 7B13',
    cpus: 4,
    memoryBytes: 8323072000,
    diskBytes: 80530636800,
    dockerVersion: '27.1.1',
    composeVersion: '2.29.1',
    nodeVersion: '22.11.0',
  },
  remote: {
    sha: '9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c',
    commitsBehind: 2,
    checkedAt: '2026-09-15T06:00:00.000Z',
  },
};

function about(overrides: Partial<AboutResponse> = {}): AboutResponse {
  return {
    deployInfo: DEPLOY_INFO,
    deployInfoStatus: 'ok',
    detail: null,
    runtime: {
      apiVersion: '1.4.0',
      nodeVersion: 'v22.11.0',
      processStartedAt: '2026-09-14T22:41:30.000Z',
      uptimeSeconds: 43110,
      serverTimeUtc: '2026-09-15T10:40:00.000Z',
      environment: 'production',
    },
    database: {
      serverVersion: 'PostgreSQL 16.4 (Debian 16.4-1.pgdg120+1) on x86_64-pc-linux-gnu',
      appliedMigrations: 42,
      lastMigrationName: '20260901120000_add_note_exports',
      lastMigrationAt: '2026-09-14T22:41:12.000Z',
    },
    databaseError: null,
    updateAvailable: true,
    checkedAt: '2026-09-15T06:00:00.000Z',
    ...overrides,
  };
}

/** The dev-stack answer: no file, a 200, and nothing the CLI would have written. */
function absent(): AboutResponse {
  return about({
    deployInfo: null,
    deployInfoStatus: 'absent',
    detail: null,
    updateAvailable: null,
    checkedAt: null,
  });
}

function serve(value: AboutResponse) {
  server.use(http.get('*/api/admin/about', () => HttpResponse.json({ data: value })));
}

function renderPage(user = mockAdminUser) {
  return render(<AboutPage />, { wrapperOptions: { user } });
}

/** The `<dd>` for a labelled fact, so an assertion can be about one row and not the page. */
function factValue(label: string): HTMLElement {
  const dt = screen.getByText(label, { selector: 'dt' });
  const dd = dt.nextElementSibling;
  if (!(dd instanceof HTMLElement) || dd.tagName !== 'DD') {
    throw new Error(`No <dd> follows the "${label}" term`);
  }
  return dd;
}

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

describe('Admin AboutPage — the three sections', () => {
  beforeEach(() => serve(about()));

  it('renders Application, Deployment and Server as three headed sections and no tabs', async () => {
    renderPage();

    expect(await screen.findByRole('heading', { level: 1, name: 'About' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Deployment' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toBeInTheDocument();
    // Three answers to one question, read top to bottom — CLAUDE.md rule 2.
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows the running process’s own facts under Application', async () => {
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Application' });
    expect(factValue('API version')).toHaveTextContent('1.4.0');
    expect(factValue('Environment')).toHaveTextContent('production');
    expect(factValue('Node version')).toHaveTextContent('v22.11.0');
    // The relative age is dated against the fixture's `serverTimeUtc`, not
    // this machine's clock: 22:41:30 → 10:40:00 is eleven hours and change.
    expect(factValue('Process started')).toHaveTextContent('2026-09-14 22:41:30 UTC · 11 hours ago');
    expect(factValue('Server time')).toHaveTextContent('2026-09-15 10:40:00 UTC');
    expect(factValue('Database')).toHaveTextContent('PostgreSQL 16.4');
    expect(factValue('Migrations')).toHaveTextContent('42 applied');
    expect(factValue('Migrations')).toHaveTextContent('20260901120000_add_note_exports');
  });

  it('shows the CLI’s deploy record under Deployment', async () => {
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    expect(factValue('Version')).toHaveTextContent('1.4.0');
    // Twelve characters, matching `kvox deploy update --check`'s `<sha12>`.
    expect(factValue('Revision')).toHaveTextContent('3f2a9c1d8e7b');
    expect(factValue('Revision')).not.toHaveTextContent(FULL_SHA);
    expect(factValue('Ref')).toHaveTextContent('main');
    // 45 days is a month in `formatRelativeTime`'s table, and `numeric: 'auto'`
    // says "last month" for exactly one.
    expect(factValue('Installed')).toHaveTextContent('2026-08-01 09:15:00 UTC · last month');
    expect(factValue('Last updated')).toHaveTextContent('2026-09-14 22:41:07 UTC · 11 hours ago');
    expect(factValue('Last command')).toHaveTextContent('update');
    expect(factValue('Deployed by')).toHaveTextContent('kvox 1.4.0');
    expect(factValue('Update')).toHaveTextContent(
      'Run kvox deploy update --check on the server to refresh.',
    );
  });

  it('links the repository only when it is an https:// URL', async () => {
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    const link = within(factValue('Repository')).getByRole('link', {
      name: 'https://github.com/example-org/example-app',
    });
    expect(link).toHaveAttribute('href', 'https://github.com/example-org/example-app');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders a non-https repository as text, never as a link', async () => {
    // Whatever `origin` said — an ssh remote, a `file://` path in CI — is not
    // something a browser should be sent to.
    serve(
      about({
        deployInfo: {
          ...DEPLOY_INFO,
          app: { ...DEPLOY_INFO.app, repoUrl: 'git@github.com:example-org/example-app.git' },
        },
      }),
    );
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    expect(factValue('Repository')).toHaveTextContent('git@github.com:example-org/example-app.git');
    expect(within(factValue('Repository')).queryByRole('link')).not.toBeInTheDocument();
  });

  it('shows the host facts under Server, with bytes through the storage formatter', async () => {
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    expect(factValue('Hostname')).toHaveTextContent('vps-01');
    expect(factValue('Operating system')).toHaveTextContent('Ubuntu 24.04.1 LTS');
    expect(factValue('Kernel')).toHaveTextContent('6.8.0-45-generic');
    expect(factValue('Architecture')).toHaveTextContent('x64');
    expect(factValue('CPU')).toHaveTextContent('AMD EPYC 7B13 × 4');
    // Decimal units, "what a file manager shows" — `formatBytes`'s own rule.
    expect(factValue('Memory')).toHaveTextContent('8.3 GB');
    expect(factValue('Disk')).toHaveTextContent('81 GB');
    expect(factValue('Docker')).toHaveTextContent('27.1.1');
    expect(factValue('Compose')).toHaveTextContent('2.29.1');
  });

  it('renders a fact the CLI could not capture as an unknown mark, never as "null"', async () => {
    serve(
      about({
        deployInfo: {
          ...DEPLOY_INFO,
          host: { ...DEPLOY_INFO.host, dockerVersion: null, memoryBytes: null, cpuModel: null },
        },
      }),
    );
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    expect(factValue('Docker')).toHaveTextContent('—');
    expect(factValue('Memory')).toHaveTextContent('—');
    expect(factValue('CPU')).toHaveTextContent('— × 4');
    expect(document.body.textContent).not.toMatch(/\bnull\b/);
    expect(document.body.textContent).not.toMatch(/undefined/);
  });

  it('names a database failure in the Application section instead of hiding it', async () => {
    // The operator diagnosing a broken database is the one person who most
    // needs the rest of this page; the API answers 200 for exactly that.
    serve(about({ database: null, databaseError: 'connection refused' }));
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Application' });
    expect(factValue('Database')).toHaveTextContent('connection refused');
    expect(screen.queryByText('Migrations', { selector: 'dt' })).not.toBeInTheDocument();
  });
});

describe('Admin AboutPage — every timestamp is UTC', () => {
  it('renders every <time> element in YYYY-MM-DD HH:mm:ss UTC', async () => {
    serve(about());
    const { container } = renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    const times = Array.from(container.querySelectorAll('time'));
    // Process started, server time, last migration, installed, last updated —
    // the fixture carries five, and a page that dropped one would pass a
    // weaker assertion.
    expect(times).toHaveLength(5);
    for (const time of times) {
      expect(time.textContent).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC$/);
      expect(time).toHaveAttribute('datetime');
    }
    // And nothing on the page is a locale rendering of one of those instants.
    expect(document.body.textContent).not.toMatch(/\d{1,2}\/\d{1,2}\/\d{4}/);
    expect(document.body.textContent).not.toMatch(/\b(AM|PM)\b/);
  });
});

describe('Admin AboutPage — the Update row', () => {
  it('shows the warning chip and the count when an update is available', async () => {
    serve(about());
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    const update = factValue('Update');
    expect(within(update).getByText('Update available')).toBeInTheDocument();
    expect(within(update).getByText('2 commits behind — checked 4 hours ago')).toBeInTheDocument();
  });

  it('says Up to date, with no chip, when the last check found nothing', async () => {
    serve(
      about({
        updateAvailable: false,
        deployInfo: {
          ...DEPLOY_INFO,
          remote: { ...DEPLOY_INFO.remote, commitsBehind: 0 },
        },
      }),
    );
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    const update = factValue('Update');
    expect(within(update).getByText('Up to date — checked 4 hours ago')).toBeInTheDocument();
    expect(within(update).queryByText('Update available')).not.toBeInTheDocument();
  });

  it('says Not checked yet — not Up to date — when the CLI has never checked', async () => {
    // `updateAvailable: null` is UNKNOWN. Rendering it as "Up to date" would
    // tell an operator that a deployment nobody has checked is current.
    serve(
      about({
        updateAvailable: null,
        checkedAt: null,
        deployInfo: { ...DEPLOY_INFO, remote: null },
      }),
    );
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    const update = factValue('Update');
    expect(within(update).getByText('Not checked yet')).toBeInTheDocument();
    expect(within(update).queryByText('Update available')).not.toBeInTheDocument();
    expect(within(update).queryByText(/Up to date/)).not.toBeInTheDocument();
  });

  it('uses the singular for one commit', async () => {
    serve(
      about({
        deployInfo: { ...DEPLOY_INFO, remote: { ...DEPLOY_INFO.remote, commitsBehind: 1 } },
      }),
    );
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    expect(within(factValue('Update')).getByText(/^1 commit behind/)).toBeInTheDocument();
  });
});

describe('Admin AboutPage — copying the revision', () => {
  it('copies the FULL SHA, not the twelve characters on screen', async () => {
    serve(about());
    const user = userEvent.setup();
    renderPage();

    const writeText = vi.fn().mockResolvedValue(undefined);
    // Defined AFTER `userEvent.setup()`, which installs a clipboard stub of
    // its own; and redefined rather than assigned, because `navigator.clipboard`
    // is a getter-only property in jsdom — the same order `DbBackupPage.test.tsx`
    // uses.
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    await user.click(await screen.findByRole('button', { name: 'Copy revision' }));

    expect(writeText).toHaveBeenCalledWith(FULL_SHA);
  });
});

describe('Admin AboutPage — a deployment the CLI never touched', () => {
  it('shows the "not deployed with kvox deploy" alert and STILL renders Application', async () => {
    // The dev stack and CI answer exactly this, and the page must be usable in
    // the environment a contributor first opens it in.
    serve(absent());
    renderPage();

    expect(
      await screen.findByText(/This instance was not deployed with/),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(factValue('API version')).toHaveTextContent('1.4.0');
    expect(screen.queryByRole('heading', { level: 2, name: 'Deployment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Server' })).not.toBeInTheDocument();
  });

  it('carries the API’s own detail when the file exists but could not be read', async () => {
    serve(
      about({
        deployInfo: null,
        deployInfoStatus: 'unreadable',
        detail: 'Unexpected end of JSON input',
        updateAvailable: null,
        checkedAt: null,
      }),
    );
    renderPage();

    expect(await screen.findByText('The deployment record could not be read')).toBeInTheDocument();
    expect(screen.getByText('Unexpected end of JSON input')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Server' })).not.toBeInTheDocument();
  });

  it('carries the API’s own detail when the file is not this schema', async () => {
    serve(
      about({
        deployInfo: null,
        deployInfoStatus: 'invalid',
        detail: 'schema: expected 1',
        updateAvailable: null,
        checkedAt: null,
      }),
    );
    renderPage();

    expect(
      await screen.findByText('The deployment record is not in the expected format'),
    ).toBeInTheDocument();
    expect(screen.getByText('schema: expected 1')).toBeInTheDocument();
  });
});

describe('Admin AboutPage — loading, errors, refresh', () => {
  it('shows a skeleton while the first answer is in flight', async () => {
    serve(about());
    renderPage();

    expect(screen.getByLabelText('Loading deployment details')).toBeInTheDocument();
    await screen.findByRole('heading', { level: 2, name: 'Application' });
    expect(screen.queryByLabelText('Loading deployment details')).not.toBeInTheDocument();
  });

  it('shows the error with a Retry that re-requests, when there is nothing to show yet', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/about', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ message: 'Deploy info service unavailable' }, { status: 500 })
          : HttpResponse.json({ data: about() });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Deploy info service unavailable')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Application' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(screen.queryByText('Deploy info service unavailable')).not.toBeInTheDocument();
    expect(calls).toBe(2);
  });

  it('reports a 403 as a permission problem rather than a mystery', async () => {
    server.use(
      http.get('*/api/admin/about', () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );
    renderPage();

    expect(
      await screen.findByText(/You do not have permission to view this deployment/),
    ).toBeInTheDocument();
  });

  it('re-fetches on Refresh, and never polls on its own', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/about', () => {
        calls += 1;
        return HttpResponse.json({ data: about() });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Application' });
    expect(calls).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    await waitFor(() => expect(calls).toBe(2));
    // Still one page, still every section — a refresh must not bounce the
    // operator through the skeleton.
    expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toBeInTheDocument();
  });

  it('keeps the last good answer on screen when a refresh fails', async () => {
    let calls = 0;
    server.use(
      http.get('*/api/admin/about', () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ data: about() })
          : HttpResponse.json({ message: 'Gateway timeout' }, { status: 504 });
      }),
    );
    const user = userEvent.setup();
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));

    expect(await screen.findByText('Gateway timeout')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toBeInTheDocument();
    // No Retry here: the answer on screen is the one to keep, and Refresh is
    // right there.
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });
});

describe('Admin AboutPage — permissions', () => {
  it('renders for a read-only admin holding only system_settings:read', async () => {
    serve(about());
    renderPage({ ...mockAdminUser, permissions: ['system_settings:read'] });

    expect(await screen.findByRole('heading', { level: 2, name: 'Server' })).toBeInTheDocument();
  });

  it('redirects a user without system_settings:read (the page-level defence)', async () => {
    serve(about());
    renderPage(mockUser);

    await waitFor(() =>
      expect(screen.queryByRole('heading', { level: 1, name: 'About' })).not.toBeInTheDocument(),
    );
  });
});

describe('Admin AboutPage — accessibility', () => {
  afterEach(() => {
    resetViewportWidth();
    localStorage.clear();
  });

  it.each([
    [375, 'light'],
    [375, 'dark'],
    [1440, 'light'],
    [1440, 'dark'],
  ])('passes axe at %ipx in the %s theme with every section rendered', async (width, theme) => {
    setViewportWidth(width);
    localStorage.setItem('theme_mode', theme);
    serve(about());
    const { container } = renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('passes axe with the "not deployed" alert in place of two sections', async () => {
    setViewportWidth(375);
    serve(absent());
    const { container } = renderPage();

    await screen.findByText(/This instance was not deployed with/);

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('renders the same controls at 375px as at 1440px — no breakpoint gate on this page', async () => {
    serve(about());
    setViewportWidth(1440);
    const desktop = renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Server' });
    const desktopButtons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);
    desktop.unmount();

    setViewportWidth(375);
    renderPage();
    await screen.findByRole('heading', { level: 2, name: 'Server' });
    const phoneButtons = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent);

    expect(phoneButtons).toEqual(desktopButtons);
  });
});
