/**
 * Admin → Settings → About (`/admin/settings/about`), issue #126, epic #118.
 *
 * The acceptance criteria are the three sections from a live response, the
 * no-deployment-record alert with Application still shown, every timestamp in
 * UTC, and the update chip appearing only when an update exists — so the
 * assertions below are about exactly those, plus the two affordances a
 * read-only page still has (Refresh, and copying the revision).
 *
 * ISSUE #283 ADDED A THIRD DEPLOYMENT-RECORD STATE, and it is not a fourth
 * `deployInfoStatus`: a record whose run did not finish is `ok`, every fact in
 * it accurate, plus a warning naming the step that stopped the run. The two
 * things a regression here would reach for are pinned below — branching on the
 * status instead of on `deployRunComplete === false`, and re-deriving "did it
 * finish" from `deployInfo.run` instead of reading the field the API derives.
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
  run: { completed: true },
};

/** What the CLI records when a step after `health` stopped the run. */
const INCOMPLETE_RUN = {
  completed: false,
  failedStep: 'publish',
  attemptedAt: '2026-09-15T09:12:00.000Z',
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
    deployRunComplete: true,
    deployFailedStep: null,
    deployAttemptedAt: null,
    ...overrides,
  };
}

/**
 * The answer issue #283 was filed about: the CLI cloned, built, migrated,
 * seeded, started and certificated the stack, and the install then failed at
 * its very last action — AFTER the API was already answering. The record is
 * `ok` and every fact in it is accurate; only the run is unfinished.
 */
function incompleteRun(): AboutResponse {
  return about({
    deployInfo: { ...DEPLOY_INFO, run: INCOMPLETE_RUN },
    deployRunComplete: false,
    deployFailedStep: 'publish',
    deployAttemptedAt: '2026-09-15T09:12:00.000Z',
  });
}

/** The dev-stack answer: no file, a 200, and nothing the CLI would have written. */
function absent(): AboutResponse {
  return about({
    deployInfo: null,
    deployInfoStatus: 'absent',
    detail: null,
    updateAvailable: null,
    checkedAt: null,
    // `null`, not `false`: no record is not a failed run.
    deployRunComplete: null,
    deployFailedStep: null,
    deployAttemptedAt: null,
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
      'Run deploy update --check with the deploy CLI on the server to refresh.',
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

describe('Admin AboutPage — no deployment record at all', () => {
  it('says the record was not found, and STILL renders Application', async () => {
    // The dev stack and CI answer exactly this, and the page must be usable in
    // the environment a contributor first opens it in.
    serve(absent());
    renderPage();

    expect(await screen.findByText('No deployment record was found')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Application' })).toBeInTheDocument();
    expect(factValue('API version')).toHaveTextContent('1.4.0');
    expect(screen.queryByRole('heading', { level: 2, name: 'Deployment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 2, name: 'Server' })).not.toBeInTheDocument();
  });

  it('states what is known and never asserts HOW the instance was deployed (#283)', async () => {
    // THE HALF OF #283 THIS PAGE OWNS. `absent` means "no file at
    // DEPLOY_INFO_PATH". That is consistent with "deployed some other way" —
    // and equally with a mis-set path, a bind mount that did not attach, or a
    // run that stopped before the record was written. The page used to state
    // the most confident of those as fact, on a server the CLI had in fact
    // installed, built, migrated and certificated.
    serve(absent());
    renderPage();

    await screen.findByText('No deployment record was found');

    // The sentence this issue was filed about is GONE, in any form.
    expect(screen.queryByText(/was not deployed with/i)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/not deployed/i);
    // What replaced it names where the API looked, and offers the other
    // explanations rather than picking one.
    expect(screen.getByText(/DEPLOY_INFO_PATH/)).toBeInTheDocument();
    expect(screen.getByText(/bind mount/i)).toBeInTheDocument();
  });

  it('keeps the no-record alert informational, not a failure', async () => {
    // An instance genuinely deployed another way is an ordinary state, so the
    // severity stays `info` — a warning here would cry wolf on every dev stack.
    serve(absent());
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveClass('MuiAlert-colorInfo');
  });

  it('carries the API’s own detail when the file exists but could not be read', async () => {
    serve(
      about({
        deployInfo: null,
        deployInfoStatus: 'unreadable',
        detail: 'Unexpected end of JSON input',
        updateAvailable: null,
        checkedAt: null,
        deployRunComplete: null,
        deployFailedStep: null,
        deployAttemptedAt: null,
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
        deployRunComplete: null,
        deployFailedStep: null,
        deployAttemptedAt: null,
      }),
    );
    renderPage();

    expect(
      await screen.findByText('The deployment record is not in the expected format'),
    ).toBeInTheDocument();
    expect(screen.getByText('schema: expected 1')).toBeInTheDocument();
  });
});

describe('Admin AboutPage — a deploy run that did not finish (#283)', () => {
  // THE REPORTED FAILURE. On a live, CLI-deployed production instance the CLI
  // had cloned, built, migrated 21 times, seeded, started the stack and issued
  // the certificate; the install failed only at its very last action, AFTER
  // the API was already answering. Every deployment fact is therefore true,
  // and the page must show all of them AND say the run did not finish.
  //
  // THE WARNING IS BRANCHED ON `deployRunComplete === false`, NEVER ON THE
  // STATUS. An incomplete run is `deployInfoStatus: 'ok'` — the record parsed
  // perfectly — so a status branch would have to choose between rendering the
  // facts and reporting the failure, which is the choice this whole contract
  // exists to remove.

  it('renders every deployment fact in full, undegraded, when the run did not finish', async () => {
    serve(incompleteRun());
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Deployment' });
    expect(screen.getByRole('heading', { level: 2, name: 'Server' })).toBeInTheDocument();
    expect(factValue('Version')).toHaveTextContent('1.4.0');
    expect(factValue('Revision')).toHaveTextContent('3f2a9c1d8e7b');
    expect(factValue('Ref')).toHaveTextContent('main');
    expect(factValue('Installed')).toHaveTextContent('2026-08-01 09:15:00 UTC');
    expect(factValue('Last updated')).toHaveTextContent('2026-09-14 22:41:07 UTC');
    expect(factValue('Deployed by')).toHaveTextContent('kvox 1.4.0');
    expect(factValue('Hostname')).toHaveTextContent('vps-01');
  });

  it('warns, naming the step that stopped the run', async () => {
    serve(incompleteRun());
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(
      within(alert).getByText('The deploy run that wrote this record did not finish'),
    ).toBeInTheDocument();
    // The step id itself, verbatim — an operator matches it against the
    // CLI's own output, so the page must not paraphrase it.
    expect(within(alert).getByText('publish', { selector: 'code' })).toBeInTheDocument();
    // A warning, unlike the no-record alert: a run that stopped is a real
    // problem somebody has to finish, not an ordinary state.
    expect(alert).toHaveClass('MuiAlert-colorWarning');
  });

  it('labels the run\u2019s ending distinctly from the last deploy that succeeded', async () => {
    // TWO TIMESTAMPS THAT MEAN DIFFERENT THINGS. On an update that failed past
    // its health step, `updatedAt` stays at the previous SUCCESS while
    // `app.commitSha` names the revision now serving. Rendering both under the
    // same word is how this page would lose an operator\u2019s trust.
    serve(incompleteRun());
    renderPage();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/Run stopped/)).toBeInTheDocument();
    // The alert carries the attempt; the Deployment row carries the success.
    const attempted = within(alert).getByText('2026-09-15 09:12:00 UTC');
    expect(attempted).toBeInTheDocument();
    expect(alert).not.toHaveTextContent('2026-09-14 22:41:07 UTC');
    expect(factValue('Last updated')).toHaveTextContent('2026-09-14 22:41:07 UTC');
    expect(factValue('Last updated')).not.toHaveTextContent('2026-09-15 09:12:00 UTC');
  });

  it('renders the unfinished-run timestamp in UTC like every other one', async () => {
    serve(incompleteRun());
    renderPage();

    const alert = await screen.findByRole('alert');
    const times = within(alert).getAllByText((_, el) => el?.tagName === 'TIME');
    expect(times.length).toBeGreaterThan(0);
    for (const time of times) {
      expect(time.textContent).toMatch(/ UTC$/);
      expect(time.getAttribute('dateTime')).toBeTruthy();
    }
  });

  it('shows NO warning when the run completed — the page is exactly today\u2019s', async () => {
    serve(about());
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.queryByText(/did not finish/i)).not.toBeInTheDocument();
  });

  it('shows NO warning for a record with no `run` block at all — an older CLI wrote it', async () => {
    // THE GUARD AGAINST RE-DERIVING THE CONVENTION HERE. Every info.json
    // already on every live server has no `run`, and each was written only
    // after a pipeline finished. The API has already interpreted that absence
    // as `deployRunComplete: true`; a page testing `deployInfo.run?.completed
    // !== true` instead would report every one of those deployments as a
    // failed one — the same class of wrongness as the bug being fixed.
    const { run: _run, ...older } = DEPLOY_INFO;
    expect(_run).toBeDefined();
    serve(about({ deployInfo: older, deployRunComplete: true }));
    renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(factValue('Version')).toHaveTextContent('1.4.0');
  });

  it('shows NO run warning when there is no record at all — null is not false', async () => {
    serve(absent());
    renderPage();

    await screen.findByText('No deployment record was found');
    expect(screen.queryByText(/did not finish/i)).not.toBeInTheDocument();
  });

  it('passes axe with the unfinished-run warning above the two sections', async () => {
    serve(incompleteRun());
    const { container } = renderPage();

    await screen.findByRole('heading', { level: 2, name: 'Server' });

    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
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

  it('passes axe with the no-record alert in place of two sections', async () => {
    setViewportWidth(375);
    serve(absent());
    const { container } = renderPage();

    await screen.findByText('No deployment record was found');

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
