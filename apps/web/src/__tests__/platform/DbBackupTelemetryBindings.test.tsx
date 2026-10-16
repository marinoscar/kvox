/**
 * This app's bindings of the packaged Database Backup and Telemetry slices
 * (issue #471, epic #467).
 *
 * The pages' own behaviour (policy form, run history, restore dialog, explorer,
 * dashboard) is proved by `@marinoscar/platform-web`'s suite. These cases cover
 * this app's glue only:
 *
 *   - the db-backup adapters hand the package this app's table and one client,
 *     and the packaged page reads through this app's transport;
 *   - `AppTelemetryConfigProvider` fetches `GET /api/telemetry/config` once the
 *     session is authenticated and not before, reports "loading" until the first
 *     answer lands (so a deep link is not redirected on a guess), and answers
 *     "off" for a signed-out session;
 *   - `RequireTelemetryEnabled` over that provider shows the page when the
 *     feature is on and redirects when it is off;
 *   - the telemetry adapters answer from the platform AI slice (`GET
 *     /api/ai/config`, `GET /api/admin/ai/models`) and hand over this app's
 *     spinner.
 *
 * Over the real packaged components and MSW: a `vi.mock` of the headless hooks
 * cannot reach the packaged pages (Vite externalises the package).
 */

import { describe, it, expect } from 'vitest';
import type { ReactNode } from 'react';
import { Route, Routes } from 'react-router-dom';
import { http, HttpResponse } from 'msw';
import { DbBackupWebAdaptersProvider } from '@marinoscar/platform-web/db-backup/headless';
import { DbBackupPage } from '@marinoscar/platform-web/db-backup/ui';
import {
  RequireTelemetryEnabled,
  TelemetryWebAdaptersProvider,
  useTelemetryFeatures,
} from '@marinoscar/platform-web/telemetry/headless';
import { render, screen, waitFor } from '../utils/test-utils';
import { mockAdminUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { DataTable } from '../../components/datatable';
import { LoadingSpinner } from '../../components/common/LoadingSpinner';
import { appDbBackupAdapters } from '../../platform/dbBackupAdapters';
import { appTelemetryAdapters } from '../../platform/telemetryAdapters';
import { AppTelemetryConfigProvider } from '../../platform/TelemetryConfigBinding';
import { AppAiConfigProvider } from '../../platform/AiConfigBinding';

describe('the Database Backup adapters', () => {
  it('hand the package this app\'s table and a client of their own', () => {
    expect(appDbBackupAdapters.DataTable).toBe(DataTable);
    expect(appDbBackupAdapters.api).toBeDefined();
  });
});

describe('the packaged Database Backup page', () => {
  it('mounts and reads the policy and the history through this app\'s client', async () => {
    const seen: string[] = [];
    server.use(
      http.get('*/api/admin/db-backup/config', () => {
        seen.push('config');
        return HttpResponse.json({
          data: {
            enabled: false,
            frequency: 'daily',
            dayOfWeek: 0,
            dayOfMonth: 1,
            timeOfDay: '02:00',
            timezone: 'UTC',
            retentionCount: 7,
            storageProvider: 's3',
            runStaleMinutes: 120,
            compressionLevel: 6,
            restoreRollbackMode: 'drop',
            oldDatabaseRetentionHours: 24,
            nextRunAt: null,
            activeRunId: null,
            restore: { available: true, reason: null },
          },
        });
      }),
      http.get('*/api/admin/db-backup/runs', () => {
        seen.push('runs');
        return HttpResponse.json({
          data: { items: [], total: 0, page: 1, pageSize: 25, totalPages: 0 },
        });
      }),
    );

    render(
      <DbBackupWebAdaptersProvider adapters={appDbBackupAdapters}>
        <DbBackupPage />
      </DbBackupWebAdaptersProvider>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    await screen.findByRole('heading', { name: 'Database Backup' });
    await waitFor(() => expect(seen).toEqual(expect.arrayContaining(['config', 'runs'])));
  });
});

describe('the telemetry adapters', () => {
  it('hand the package this app\'s spinner', () => {
    expect(appTelemetryAdapters.Spinner).toBe(LoadingSpinner);
  });

  function AdaptersProbe() {
    const ai = appTelemetryAdapters.useAiEnabled();
    const picker = appTelemetryAdapters.useAssistantModels();
    return (
      <div>
        <div data-testid="ai">{String(ai.enabled)}</div>
        <div data-testid="ai-loading">{String(ai.isLoading)}</div>
        <div data-testid="picker-loading">{String(picker.isLoading)}</div>
        <div data-testid="picker-error">{String(picker.error)}</div>
        <ul>
          {picker.models.map((model) => (
            <li key={model.id}>
              {model.provider}:{model.modelId}|{model.label}|{String(model.supportsToolCalling)}
            </li>
          ))}
        </ul>
      </div>
    );
  }

  const catalogueRow = (
    id: string,
    modelId: string,
    displayName: string | null,
    capabilities: string[] | null,
  ) => ({
    id,
    provider: 'openai',
    modelId,
    displayName,
    capabilities: capabilities && {
      capabilities,
      inputModalities: ['text'],
      outputModalities: ['text'],
    },
    capabilitySource: capabilities ? 'catalog' : 'unclassified',
    enabled: true,
    contextWindow: null,
    maxOutputTokens: null,
    discoveredAt: '2026-01-01T00:00:00.000Z',
    lastSeenAt: '2026-01-01T00:00:00.000Z',
    deprecatedAt: null,
    updatedAt: '2026-01-01T00:00:00.000Z',
    updatedByUserId: null,
  });

  it('answer from the platform AI slice: the shell-wide switch and the enabled catalogue', async () => {
    const filters: string[] = [];
    server.use(
      http.get('*/api/ai/config', () =>
        HttpResponse.json({ data: { enabled: true, keyPolicy: 'byok', providers: [] } }),
      ),
      http.get('*/api/admin/ai/models', ({ request }) => {
        filters.push(new URL(request.url).search);
        return HttpResponse.json({
          data: {
            items: [
              catalogueRow('m1', 'gpt-4o', 'GPT-4o', ['chat', 'tools']),
              catalogueRow('m2', 'gpt-4o-mini', null, ['chat']),
              catalogueRow('m3', 'mystery', null, null),
            ],
            total: 3,
            page: 1,
            pageSize: 100,
          },
        });
      }),
    );

    render(
      <AppAiConfigProvider>
        <AdaptersProbe />
      </AppAiConfigProvider>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    await waitFor(() => expect(screen.getByTestId('ai')).toHaveTextContent('true'));
    await screen.findByText('openai:gpt-4o|GPT-4o|true');
    expect(screen.getByText('openai:gpt-4o-mini|gpt-4o-mini|false')).toBeInTheDocument();
    // A model nobody has classified cannot call tools as far as the assistant knows.
    expect(screen.getByText('openai:mystery|mystery|false')).toBeInTheDocument();
    expect(screen.getByTestId('picker-error')).toHaveTextContent('null');
    expect(filters[0]).toContain('enabled=true');
    expect(filters[0]).toContain('pageSize=100');
  });

  it('answer "AI off" when the deployment has it switched off', async () => {
    server.use(
      http.get('*/api/ai/config', () =>
        HttpResponse.json({ data: { enabled: false, keyPolicy: 'byok', providers: [] } }),
      ),
      http.get('*/api/admin/ai/models', () =>
        HttpResponse.json({ data: { items: [], total: 0, page: 1, pageSize: 100 } }),
      ),
    );

    render(
      <AppAiConfigProvider>
        <AdaptersProbe />
      </AppAiConfigProvider>,
      { wrapperOptions: { user: mockAdminUser } },
    );

    await waitFor(() => expect(screen.getByTestId('ai-loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('ai')).toHaveTextContent('false');
  });
});

function FeatureProbe() {
  return <div data-testid="feature">{String(useTelemetryFeatures().telemetry)}</div>;
}

function Guarded({ children }: { children: ReactNode }) {
  return (
    <AppTelemetryConfigProvider>
      <TelemetryWebAdaptersProvider adapters={appTelemetryAdapters}>
        <FeatureProbe />
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route
            path="/telemetry"
            element={<RequireTelemetryEnabled>{children}</RequireTelemetryEnabled>}
          />
        </Routes>
      </TelemetryWebAdaptersProvider>
    </AppTelemetryConfigProvider>
  );
}

function serveConfig(config: { available: boolean; enabled: boolean }, seen?: string[]) {
  server.use(
    http.get('*/api/telemetry/config', () => {
      seen?.push('config');
      return HttpResponse.json({ data: { ...config, assistantEnabled: false } });
    }),
  );
}

describe('AppTelemetryConfigProvider', () => {
  it('turns the telemetry feature on when a store is deployed and collection is on', async () => {
    serveConfig({ available: true, enabled: true });
    render(<Guarded>explorer</Guarded>, {
      wrapperOptions: { user: mockAdminUser, route: '/telemetry' },
    });

    await screen.findByText('explorer');
    expect(screen.getByTestId('feature').textContent).toBe('true');
  });

  it('redirects a guarded route home while collection is off, rather than showing the page', async () => {
    serveConfig({ available: true, enabled: false });
    render(<Guarded>explorer</Guarded>, {
      wrapperOptions: { user: mockAdminUser, route: '/telemetry' },
    });

    await screen.findByText('home');
    expect(screen.queryByText('explorer')).toBeNull();
    expect(screen.getByTestId('feature').textContent).toBe('false');
  });

  it('does not redirect a deep link on the render before the first answer lands', async () => {
    // The race the binding closes: a skipped query starts "not loading" and
    // flips only inside an effect, so without the binding's own `isLoading` the
    // guard would see "off, not loading" and send the user home. A slow answer
    // makes the gap observable.
    server.use(
      http.get('*/api/telemetry/config', async () => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return HttpResponse.json({
          data: { available: true, enabled: true, assistantEnabled: false },
        });
      }),
    );
    render(<Guarded>explorer</Guarded>, {
      wrapperOptions: { user: mockAdminUser, route: '/telemetry' },
    });

    expect(screen.queryByText('home')).toBeNull();
    await screen.findByText('explorer');
    expect(screen.queryByText('home')).toBeNull();
  });

  it('fails closed when the answer cannot be read', async () => {
    server.use(http.get('*/api/telemetry/config', () => HttpResponse.json({}, { status: 500 })));
    render(<Guarded>explorer</Guarded>, {
      wrapperOptions: { user: mockAdminUser, route: '/telemetry' },
    });

    await screen.findByText('home');
    expect(screen.getByTestId('feature').textContent).toBe('false');
  });

  it('makes no request, and answers "off", for a signed-out session', async () => {
    const seen: string[] = [];
    serveConfig({ available: true, enabled: true }, seen);
    render(<Guarded>explorer</Guarded>, {
      wrapperOptions: { authenticated: false, user: null, route: '/telemetry' },
    });

    await screen.findByText('home');
    expect(seen).toEqual([]);
    expect(screen.getByTestId('feature').textContent).toBe('false');
  });
});
