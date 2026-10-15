/**
 * This app's binding of the packaged Operations pages (issue #468, epic #462).
 *
 * The pages' own behaviour (filters, row actions, polling, the credential
 * dialogs) is proved by `@marinoscar/platform-web`'s suite. These cases cover
 * this app's glue only:
 *
 *   - the adapter objects hand the packages this app's table, spinner and one
 *     API client (module constants, as the packages ask);
 *   - the packaged Jobs, Job Insights and Worker Nodes pages mount under the
 *     adapter providers `App.tsx` mounts and read through this app's transport
 *     (MSW sees the `/api/admin/jobs` and `/api/admin/nodes` calls).
 *
 * Over the real packaged pages and MSW: a `vi.mock` of the headless hooks cannot
 * reach the packaged pages (Vite externalises the package).
 */

import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { JobsWebAdaptersProvider } from '@marinoscar/platform-web/jobs/headless';
import { NodesWebAdaptersProvider } from '@marinoscar/platform-web/nodes/headless';
import { JobsPage, JobInsightsPage } from '@marinoscar/platform-web/jobs/ui';
import { WorkersPage } from '@marinoscar/platform-web/nodes/ui';
import { render, screen, waitFor } from '../utils/test-utils';
import { mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { DataTable } from '../../components/datatable';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { appJobsAdapters } from '../../platform/jobsAdapters';
import { appNodesAdapters } from '../../platform/nodesAdapters';

function Adapters({ children }: { children: ReactNode }) {
  return (
    <JobsWebAdaptersProvider adapters={appJobsAdapters}>
      <NodesWebAdaptersProvider adapters={appNodesAdapters}>{children}</NodesWebAdaptersProvider>
    </JobsWebAdaptersProvider>
  );
}

const wrapperOptions = { user: mockAdminUser };

describe('the Operations adapters', () => {
  it('hand the packages this app\'s spinner and table, and a client of their own', () => {
    expect(appJobsAdapters.Spinner).toBe(LoadingSpinner);
    expect(appJobsAdapters.DataTable).toBe(DataTable);
    expect(appJobsAdapters.api).toBeDefined();
    expect(appNodesAdapters.Spinner).toBe(LoadingSpinner);
    expect(appNodesAdapters.DataTable).toBe(DataTable);
    expect(appNodesAdapters.api).toBeDefined();
  });
});

describe('the packaged Worker Nodes page', () => {
  it('mounts and reads the fleet and the credentials through this app\'s client', async () => {
    const seen: string[] = [];
    server.use(
      http.get('*/api/admin/nodes/credentials', () => {
        seen.push('credentials');
        return HttpResponse.json({ data: [] });
      }),
      http.get('*/api/admin/nodes', () => {
        seen.push('nodes');
        return HttpResponse.json({ data: [] });
      }),
    );

    render(
      <Adapters>
        <WorkersPage />
      </Adapters>,
      { wrapperOptions },
    );

    await screen.findByRole('heading', { name: 'Worker Nodes' });
    await waitFor(() => expect(seen).toEqual(expect.arrayContaining(['nodes', 'credentials'])));
  });
});

describe('the packaged Jobs pages', () => {
  it('mounts Jobs and reads the queue through this app\'s client', async () => {
    const seen: string[] = [];
    server.use(
      http.get('*/api/admin/jobs/stats', () => {
        seen.push('stats');
        return HttpResponse.json({ data: { byStatus: {}, byType: [] } });
      }),
      http.get('*/api/admin/jobs', () => {
        seen.push('list');
        return HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 },
        });
      }),
    );

    render(
      <Adapters>
        <JobsPage />
      </Adapters>,
      { wrapperOptions },
    );

    await screen.findByRole('heading', { name: 'Jobs' });
    await waitFor(() => expect(seen).toEqual(expect.arrayContaining(['list', 'stats'])));
  });

  it('mounts Job Insights', async () => {
    server.use(
      http.get('*/api/admin/jobs/insights', () =>
        HttpResponse.json({
          data: {
            generatedAt: '2026-10-15T12:00:00.000Z',
            windowDays: 7,
            concurrency: 2,
            live: {
              byStatus: { pending: 0, running: 0, succeeded: 0, failed: 0 },
              scheduled: 0,
              rateLimited: 0,
              retried: 0,
            },
            eta: [],
            history: {
              windowStart: '2026-10-08T12:00:00.000Z',
              throughputSince: '2026-10-15T11:00:00.000Z',
              overall: { samples: 0, avgMs: null, p50Ms: null, p95Ms: null, throughputPerMin: 0 },
              byType: [],
            },
            lifetime: [],
          },
        }),
      ),
    );

    render(
      <Adapters>
        <JobInsightsPage />
      </Adapters>,
      { wrapperOptions },
    );

    await screen.findByRole('heading', { name: 'Job Insights' });
  });
});
