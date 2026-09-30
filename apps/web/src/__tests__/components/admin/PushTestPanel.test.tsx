/**
 * `PushTestPanel` — the "Test & diagnostics" section of `/admin/settings/push`
 * (issue #449). The diagnostics service is mocked: its flow has its own suite
 * (`services/pushDiagnostics.test.ts`); this one covers what the panel shows
 * and which controls it gates.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../../utils/test-utils';
import type { PushConfigAdminView, PushTestResult } from '../../../services/pushConfig';
import type { BrowserSnapshot, PushTestRun } from '../../../services/pushDiagnostics';

vi.mock('../../../services/pushDiagnostics', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/pushDiagnostics')>();
  return {
    ...actual,
    collectBrowserSnapshot: vi.fn(),
    runPushTest: vi.fn(),
    showLocalTestNotification: vi.fn(),
  };
});

vi.mock('../../../services/pushSubscription', () => ({
  requestPermissionAndSyncPush: vi.fn().mockResolvedValue('granted'),
}));

vi.mock('../../../hooks/useNotificationConfig', () => ({
  useNotificationConfig: vi.fn(),
}));

import {
  collectBrowserSnapshot,
  runPushTest,
  showLocalTestNotification,
} from '../../../services/pushDiagnostics';
import { requestPermissionAndSyncPush } from '../../../services/pushSubscription';
import { useNotificationConfig } from '../../../hooks/useNotificationConfig';
import { PushTestPanel } from '../../../components/admin/PushTestPanel';

const mockSnapshot = vi.mocked(collectBrowserSnapshot);
const mockRun = vi.mocked(runPushTest);
const mockLocal = vi.mocked(showLocalTestNotification);
const mockRequest = vi.mocked(requestPermissionAndSyncPush);
const mockClientConfig = vi.mocked(useNotificationConfig);

const PUBLIC_KEY = 'BEl62iUYgUivxIkv69yViEuiBIa1HI0DLQCHUp2ZfmZC';

const config: PushConfigAdminView = {
  enabled: true,
  configured: true,
  publicKey: PUBLIC_KEY,
  subject: 'mailto:ops@example.com',
  privateKeyStatus: { configured: true, hint: '••••ab12', updatedAt: null, updatedByUserId: null },
  settingsError: null,
  version: 1,
  updatedAt: null,
  updatedBy: null,
};

function snapshot(overrides: Partial<BrowserSnapshot> = {}): BrowserSnapshot {
  return {
    collectedAt: '2026-09-30T00:00:00.000Z',
    userAgent: 'Android Chrome',
    isSecureContext: true,
    origin: 'https://app.example.com',
    hasNotificationApi: true,
    hasServiceWorkerApi: true,
    hasPushManager: true,
    isIos: false,
    isStandalone: true,
    permission: 'granted',
    permissionsApiState: 'granted',
    serviceWorker: {
      controlled: true,
      readyWithinTimeout: true,
      registration: {
        scope: 'https://app.example.com/',
        activeState: 'activated',
        waiting: false,
        installing: false,
        scriptURL: 'https://app.example.com/sw.js',
      },
    },
    subscription: {
      exists: true,
      pushService: 'fcm.googleapis.com',
      endpointPreview: 'fcm.googleapis.com/…12345678',
      expirationTime: null,
      applicationServerKey: PUBLIC_KEY,
      keyMatchesServer: true,
    },
    errors: [],
    ...overrides,
  };
}

const serverResult: PushTestResult = {
  ranAt: '2026-09-30T00:00:00.000Z',
  durationMs: 150,
  overall: 'sent',
  testId: 'push-test-abc',
  config: {
    source: 'admin',
    enabled: true,
    active: true,
    publicKey: PUBLIC_KEY,
    publicKeyValid: true,
    privateKeyMatchesPublicKey: true,
    subject: 'mailto:ops@example.com',
    subjectValid: true,
    problems: [],
  },
  browser: { endpointProvided: true, endpointRegistered: true, keyMatchesServer: true },
  events: [
    { eventKey: 'user.welcome', label: 'Welcome', mandatory: false, policyAllows: true, preferenceAllows: false },
  ],
  subscriptions: [
    {
      id: 'sub-1',
      pushService: 'fcm.googleapis.com',
      endpointPreview: 'fcm.googleapis.com/…12345678',
      isThisBrowser: true,
      userAgent: 'Android Chrome',
      createdAt: '2026-09-01T00:00:00.000Z',
      lastSuccessAt: null,
      failureCount: 0,
      result: { status: 'sent', statusCode: 201, message: null, responseBody: '{"ok":true}', durationMs: 80 },
    },
  ],
  hints: ['Server-side hint'],
};

function setClientConfig(value: { browserEnabled: boolean; pushEnabled: boolean; vapidPublicKey: string | null } | null) {
  mockClientConfig.mockReturnValue({
    config: value,
    isLoading: false,
    error: null,
    refresh: vi.fn().mockResolvedValue(undefined),
  });
}

describe('PushTestPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSnapshot.mockResolvedValue(snapshot());
    setClientConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: PUBLIC_KEY });
  });

  it('renders the section heading, permission chip and browser checklist', async () => {
    render(<PushTestPanel config={config} canWrite />);

    expect(screen.getByRole('heading', { name: 'Test & diagnostics' })).toBeInTheDocument();
    expect(await screen.findByText('Allowed')).toBeInTheDocument();
    const checks = screen.getByRole('list', { name: 'This browser checks' });
    expect(within(checks).getByText('Push subscription present')).toBeInTheDocument();
    expect(within(checks).getByText('Subscription key matches the server’s public key')).toBeInTheDocument();
    expect(mockSnapshot).toHaveBeenCalledWith(PUBLIC_KEY);
    expect(screen.getByText(/you can lock the phone or switch apps/i)).toBeInTheDocument();
  });

  it('disables Send test push without push:write, but keeps the local test and copy', async () => {
    render(<PushTestPanel config={config} canWrite={false} />);
    await screen.findByText('Allowed');

    expect(screen.getByRole('button', { name: /send test push/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /show local notification/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /copy diagnostics/i })).toBeEnabled();
    expect(screen.getByText(/needs the push:write permission/i)).toBeInTheDocument();
  });

  it('shows recovery steps when notifications are blocked', async () => {
    mockSnapshot.mockResolvedValue(snapshot({ permission: 'denied' }));

    render(<PushTestPanel config={config} canWrite />);

    expect(await screen.findByText('Notifications are blocked in this browser')).toBeInTheDocument();
    expect(screen.getByText(/Android Settings → Apps → Chrome/)).toBeInTheDocument();
  });

  it('offers Allow notifications when not yet asked', async () => {
    mockSnapshot.mockResolvedValue(snapshot({ permission: 'default' }));
    const user = userEvent.setup();

    render(<PushTestPanel config={config} canWrite />);
    await user.click(await screen.findByRole('button', { name: /allow notifications/i }));

    expect(mockRequest).toHaveBeenCalledTimes(1);
  });

  it('warns when the client-facing config disagrees with the admin view', async () => {
    setClientConfig({ browserEnabled: true, pushEnabled: false, vapidPublicKey: null });

    render(<PushTestPanel config={config} canWrite />);

    expect(await screen.findByText(/tells clients push is OFF/i)).toBeInTheDocument();
  });

  it('warns when clients receive a different public key', async () => {
    setClientConfig({ browserEnabled: true, pushEnabled: true, vapidPublicKey: 'BOTHERKEY' });

    render(<PushTestPanel config={config} canWrite />);

    expect(await screen.findByText(/differs from the key shown above/i)).toBeInTheDocument();
  });

  it('runs the test and renders steps, the ack, the server result and hints', async () => {
    const run: PushTestRun = {
      steps: [
        { id: 'support', label: 'Browser support', status: 'ok', startedAt: 0, durationMs: 1 },
        { id: 'delivery', label: 'Delivered to this device', status: 'ok', detail: 'fine', startedAt: 0, durationMs: 42 },
      ],
      server: serverResult,
      ack: { id: 'push-test-abc', receivedAt: 1, shown: true, hadFocusedClient: true, latencyMs: 42 },
      snapshot: snapshot(),
      hints: ['Client-side hint'],
    };
    mockRun.mockImplementation(async (_key, onStep) => {
      run.steps.forEach((s) => onStep?.(s));
      return run;
    });
    const user = userEvent.setup();

    render(<PushTestPanel config={config} canWrite />);
    await screen.findByText('Allowed');
    await user.click(screen.getByRole('button', { name: /send test push/i }));

    expect(await screen.findByText('Received by this device in 42 ms')).toBeInTheDocument();
    expect(mockRun).toHaveBeenCalledWith(PUBLIC_KEY, expect.any(Function));
    const steps = screen.getByRole('list', { name: 'Test steps' });
    expect(within(steps).getByText('Delivered to this device')).toBeInTheDocument();

    const card = screen.getByTestId('push-test-subscription');
    expect(within(card).getByText('This browser')).toBeInTheDocument();
    expect(within(card).getByText('HTTP 201')).toBeInTheDocument();
    expect(within(card).getByText('{"ok":true}')).toBeInTheDocument();
    expect(screen.getByText('Private key matches the public key')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Push events' })).toBeInTheDocument();
    expect(screen.getByText('Server-side hint')).toBeInTheDocument();
    expect(screen.getByText('Client-side hint')).toBeInTheDocument();
  });

  it('reports a missing ack prominently', async () => {
    mockRun.mockResolvedValue({
      steps: [
        { id: 'delivery', label: 'Delivered to this device', status: 'fail', detail: 'No acknowledgement within 20s.', startedAt: 0, durationMs: 20000 },
      ],
      server: serverResult,
      ack: null,
      snapshot: snapshot(),
      hints: [],
    });
    const user = userEvent.setup();

    render(<PushTestPanel config={config} canWrite />);
    await screen.findByText('Allowed');
    await user.click(screen.getByRole('button', { name: /send test push/i }));

    expect(await screen.findByText('Not received by this device')).toBeInTheDocument();
  });

  it('shows the local notification result', async () => {
    mockLocal.mockResolvedValue({ ok: true, via: 'service-worker' });
    const user = userEvent.setup();

    render(<PushTestPanel config={config} canWrite />);
    await screen.findByText('Allowed');
    await user.click(screen.getByRole('button', { name: /show local notification/i }));

    await waitFor(() =>
      expect(screen.getByText(/local notification shown via the service worker/i)).toBeInTheDocument(),
    );
  });
});
