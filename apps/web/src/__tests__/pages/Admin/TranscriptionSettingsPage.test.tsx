/**
 * `/admin/settings/transcription` (issue #23, epic #19).
 *
 * `useTranscriptionSettings` is mocked, matching the pattern
 * `PushConfigPage.test.tsx` and `EmailSettingsPage.test.tsx` use — this suite
 * is about the PAGE's own rendering, gating and write-only-key handling, not
 * the hook's fetch/save plumbing.
 *
 * THE ASSERTION THAT MATTERS MOST: a key that has been typed into the form must
 * reach `save`/`testConnection` and NOTHING ELSE, and a key that is merely
 * STORED must never appear in the DOM at all. Both are checked explicitly,
 * because "we never render the secret" is exactly the kind of claim that stops
 * being true one helpful `helperText` at a time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { render } from '../../utils/test-utils';
import { setViewportWidth, resetViewportWidth } from '../../setup';
import type { TranscriptionSettingsAdminView } from '../../../services/transcription';

vi.mock('../../../hooks/useTranscriptionSettings', () => ({
  useTranscriptionSettings: vi.fn(),
}));

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { useTranscriptionSettings } from '../../../hooks/useTranscriptionSettings';
import { usePermissions } from '../../../hooks/usePermissions';
import TranscriptionSettingsPage from '../../../pages/Admin/TranscriptionSettingsPage';

const mockHook = vi.mocked(useTranscriptionSettings);
const mockPermissions = vi.mocked(usePermissions);

const WRITE = ['system_settings:read', 'system_settings:write'];
const READ_ONLY = ['system_settings:read'];

/** A value shaped like an API key — must NEVER appear in any rendered DOM node. */
const FORBIDDEN_KEY = 'aai-THIS-KEY-MUST-NOT-BE-RENDERED-1a2b3c';

function setPermissions(granted: string[]) {
  mockPermissions.mockReturnValue({
    permissions: new Set(granted),
    roles: new Set(['admin']),
    hasPermission: (permission: string) => granted.includes(permission),
    hasAnyPermission: vi.fn(),
    hasAllPermissions: vi.fn(),
    hasRole: vi.fn(),
    hasAnyRole: vi.fn(),
    isAdmin: true,
  });
}

const PROVIDER_CATALOGUE = [
  {
    id: 'assemblyai',
    label: 'AssemblyAI',
    capabilities: {
      diarization: true,
      wordTimestamps: true,
      languageDetection: true,
      speakersExpectedHint: true,
      acceptsUrl: true,
      acceptsUpload: true,
      maxInputBytes: 5_368_709_120,
      maxDurationMs: 36_000_000,
      acceptedMimeTypes: ['audio/mpeg'],
      remoteDelete: true,
      cancel: false,
    },
    fieldDescriptors: [],
  },
];

const unconfigured: TranscriptionSettingsAdminView = {
  settings: {
    enabled: false,
    provider: null,
    providers: { assemblyai: { region: 'us', speechModel: 'universal' } },
    audioDelivery: 'presigned_url',
    presignedUrlTtlMinutes: 360,
    deleteRemoteAfterIngest: true,
    defaultLanguage: null,
    transcodeNodeOffloadEnabled: true,
    abandonedUploadHours: 3,
    playback: { bitrateKbps: 64 },
  },
  keyStatuses: [
    {
      providerId: 'assemblyai',
      configured: false,
      hint: null,
      updatedAt: null,
      updatedByUserId: null,
    },
  ],
  providers: PROVIDER_CATALOGUE,
  version: 0,
  updatedAt: null,
  updatedBy: null,
};

const configured: TranscriptionSettingsAdminView = {
  settings: {
    ...unconfigured.settings,
    enabled: true,
    provider: 'assemblyai',
    providers: { assemblyai: { region: 'eu', speechModel: 'universal' } },
    defaultLanguage: 'en',
    abandonedUploadHours: 12,
  },
  keyStatuses: [
    {
      providerId: 'assemblyai',
      configured: true,
      hint: '••••2b3c',
      updatedAt: '2026-01-01T00:00:00.000Z',
      updatedByUserId: 'admin-user-id',
    },
  ],
  providers: PROVIDER_CATALOGUE,
  version: 5,
  updatedAt: '2026-01-01T00:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

function setHook(overrides: Partial<ReturnType<typeof useTranscriptionSettings>> = {}) {
  const save = vi.fn().mockResolvedValue(true);
  const testConnection = vi.fn().mockResolvedValue(undefined);
  const removeKey = vi.fn().mockResolvedValue(true);

  const value = {
    data: configured,
    isLoading: false,
    loadError: null,
    isSaving: false,
    saveError: null,
    save,
    clearSaveError: vi.fn(),
    isTesting: false,
    testResult: null,
    testConnection,
    clearTestResult: vi.fn(),
    isRemovingKey: false,
    removeKeyError: null,
    removeKey,
    clearRemoveKeyError: vi.fn(),
    refresh: vi.fn(),
    ...overrides,
  } as ReturnType<typeof useTranscriptionSettings>;

  mockHook.mockReturnValue(value);
  return { save, testConnection, removeKey, ...value };
}

beforeEach(() => {
  vi.clearAllMocks();
  setPermissions(WRITE);
});

afterEach(() => {
  resetViewportWidth();
});

describe('TranscriptionSettingsPage', () => {
  describe('rendering', () => {
    it('renders the title and the stored configuration', async () => {
      setHook();
      render(<TranscriptionSettingsPage />);

      expect(
        await screen.findByRole('heading', { name: 'Transcription', level: 1 }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Speech model')).toHaveValue('universal');
      expect(screen.getByLabelText('Default language')).toHaveValue('en');
      expect(screen.getByLabelText('Playback bitrate (kbit/s)')).toHaveValue(64);
    });

    it('shows a spinner while loading', () => {
      setHook({ data: null, isLoading: true });
      render(<TranscriptionSettingsPage />);

      expect(screen.queryByLabelText('Speech model')).not.toBeInTheDocument();
    });

    it('shows the load error instead of a form when the load failed', async () => {
      setHook({ data: null, isLoading: false, loadError: 'Nope' });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText('Nope')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument();
    });

    it('redirects a caller without system_settings:read', () => {
      setPermissions([]);
      setHook();
      const { container } = render(<TranscriptionSettingsPage />);

      // `<Navigate>` renders nothing. This is defence behind `App.tsx`'s
      // `RequirePermission`, not the gate itself.
      expect(container.querySelector('h1')).toBeNull();
    });
  });

  describe('read-only mode (system_settings:read without :write)', () => {
    beforeEach(() => setPermissions(READ_ONLY));

    it('says so in the page description', async () => {
      setHook();
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/\(read-only\)/)).toBeInTheDocument();
    });

    it('disables every control', async () => {
      setHook();
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByLabelText('Speech model')).toBeDisabled();
      expect(screen.getByLabelText('Default language')).toBeDisabled();
      expect(screen.getByLabelText('Playback bitrate (kbit/s)')).toBeDisabled();
      expect(screen.getByLabelText('Enable transcription')).toBeDisabled();
      expect(screen.getByLabelText('Delete remote data after ingest')).toBeDisabled();
      expect(screen.getByLabelText('Allow worker nodes to transcode')).toBeDisabled();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /replace key/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /remove key/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /test connection/i })).toBeDisabled();
    });

    it('still shows the configuration — the card gate is about REACHABILITY', async () => {
      // A read-only admin diagnosing "why did my recording never come back"
      // is worth letting in to look.
      setHook();
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByLabelText('Speech model')).toHaveValue('universal');
    });
  });

  describe('the API key', () => {
    it('describes the stored key with its mask, and never renders the key', async () => {
      setHook();
      const { container } = render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/API key last set \(••••2b3c\)/)).toBeInTheDocument();
      expect(container.textContent).not.toContain(FORBIDDEN_KEY);
    });

    it('hides the key field until Replace is pressed', async () => {
      const user = userEvent.setup();
      setHook();
      render(<TranscriptionSettingsPage />);

      // An administrator editing the playback bitrate should not be presented
      // with an empty password-looking box they might feel obliged to fill in.
      await screen.findByRole('button', { name: /replace key/i });
      expect(screen.queryByLabelText('API key')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /replace key/i }));

      expect(await screen.findByLabelText('API key')).toBeInTheDocument();
      expect(screen.getByLabelText('API key')).toHaveValue('');
    });

    it('shows the key field immediately when nothing is stored', async () => {
      setHook({ data: unconfigured });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByLabelText('API key')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /replace key/i }),
      ).not.toBeInTheDocument();
    });

    it('sends a typed key on save, and only there', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /replace key/i }));
      await user.type(await screen.findByLabelText('API key'), FORBIDDEN_KEY);
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0]).toMatchObject({ apiKey: FORBIDDEN_KEY });
    });

    it('OMITS apiKey entirely when the box was left empty — blank preserves', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      // Not `apiKey: ''`. Both mean "preserve" to the API, but omitting makes
      // the intent visible in the request rather than depending on a
      // server-side equivalence.
      expect(save.mock.calls[0][0]).not.toHaveProperty('apiKey');
    });

    it('removes a stored key through the dedicated control', async () => {
      const user = userEvent.setup();
      const { removeKey, save } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /remove key/i }));

      await waitFor(() => expect(removeKey).toHaveBeenCalledWith('assemblyai'));
      // Erasing must not ride along on a settings save.
      expect(save).not.toHaveBeenCalled();
    });

    it('shows a removal failure without clearing the page', async () => {
      setHook({ removeKeyError: 'Could not remove it' });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText('Could not remove it')).toBeInTheDocument();
      expect(screen.getByLabelText('Speech model')).toBeInTheDocument();
    });

    it('offers no Remove control when nothing is stored', async () => {
      setHook({ data: unconfigured });
      render(<TranscriptionSettingsPage />);

      await screen.findByLabelText('API key');
      expect(screen.queryByRole('button', { name: /remove key/i })).not.toBeInTheDocument();
    });
  });

  describe('test connection', () => {
    it('probes the UNSAVED key currently typed into the form', async () => {
      // THE WORKFLOW THIS BUTTON EXISTS FOR. A Test that could only probe the
      // saved value would turn every wrong key into a failed job discovered an
      // hour later.
      const user = userEvent.setup();
      const { testConnection } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /replace key/i }));
      await user.type(await screen.findByLabelText('API key'), FORBIDDEN_KEY);
      await user.click(screen.getByRole('button', { name: /test connection/i }));

      await waitFor(() => expect(testConnection).toHaveBeenCalled());
      expect(testConnection.mock.calls[0][0]).toEqual({
        provider: 'assemblyai',
        region: 'eu',
        apiKey: FORBIDDEN_KEY,
      });
    });

    it('probes the stored key when nothing is typed', async () => {
      const user = userEvent.setup();
      const { testConnection } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /test connection/i }));

      await waitFor(() => expect(testConnection).toHaveBeenCalled());
      expect(testConnection.mock.calls[0][0].apiKey).toBeUndefined();
    });

    it('shows a loading state while the probe is in flight', async () => {
      setHook({ isTesting: true });
      render(<TranscriptionSettingsPage />);

      const button = await screen.findByRole('button', { name: /testing/i });
      expect(button).toBeDisabled();
    });

    it('reports success with the latency', async () => {
      setHook({
        testResult: { ok: true, latencyMs: 142, detail: 'Authenticated against the EU endpoint in 142 ms.' },
      });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/Connection succeeded in 142 ms/)).toBeInTheDocument();
    });

    it('reports an invalid key with the provider\'s own explanation', async () => {
      // Not flattened to "test failed": which of three different fixes applies
      // is the entire value of this control.
      setHook({
        testResult: {
          ok: false,
          latencyMs: 88,
          detail:
            'The EU endpoint rejected this API key (HTTP 401). Either the key is wrong, or it belongs to the other region.',
        },
      });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/Connection failed/)).toBeInTheDocument();
      expect(screen.getByText(/belongs to the other region/)).toBeInTheDocument();
    });

    it('reports a wrong region distinctly from a network failure', async () => {
      setHook({
        testResult: {
          ok: false,
          latencyMs: 0,
          detail:
            'Could not reach https://api.eu.assemblyai.com — getaddrinfo ENOTFOUND. The request never got an HTTP response.',
        },
      });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/never got an HTTP response/)).toBeInTheDocument();
    });

    it('disables the probe when no provider is chosen', async () => {
      setHook({ data: unconfigured });
      render(<TranscriptionSettingsPage />);

      expect(
        await screen.findByRole('button', { name: /test connection/i }),
      ).toBeDisabled();
    });

    it('never renders the typed key in the result region', async () => {
      const user = userEvent.setup();
      setHook({
        testResult: { ok: false, latencyMs: 10, detail: 'The endpoint rejected this API key.' },
      });
      const { container } = render(<TranscriptionSettingsPage />);

      await user.click(await screen.findByRole('button', { name: /replace key/i }));
      await user.type(await screen.findByLabelText('API key'), FORBIDDEN_KEY);

      // The `<input type="password">` holds it as a value, which is unavoidable
      // and is not a render; what must never happen is the key reaching a TEXT
      // node somewhere on the page.
      expect(container.textContent).not.toContain(FORBIDDEN_KEY);
    });
  });

  describe('saving', () => {
    it('sends the whole draft, with null for an empty default language', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      await user.clear(await screen.findByLabelText('Default language'));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      // `null`, not `''`. Null is how "ask the provider to detect it" is
      // expressed; an empty string is a language code nobody has.
      expect(save.mock.calls[0][0].defaultLanguage).toBeNull();
    });

    it('refuses to save an out-of-range playback bitrate', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      const bitrate = await screen.findByLabelText('Playback bitrate (kbit/s)');
      await user.clear(bitrate);
      await user.type(bitrate, '5');

      expect(
        await screen.findByText(/whole number between 16 and 320/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(save).not.toHaveBeenCalled();
    });

    it('renders the stored abandoned-upload window and sends a changed one (issue #322)', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      const hours = await screen.findByLabelText('Abandoned upload cleanup (hours)');
      expect(hours).toHaveValue(12);

      await user.clear(hours);
      await user.type(hours, '48');
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(save).toHaveBeenCalled());
      expect(save.mock.calls[0][0].abandonedUploadHours).toBe(48);
    });

    it('refuses to save an out-of-range abandoned-upload window', async () => {
      const user = userEvent.setup();
      const { save } = setHook();
      render(<TranscriptionSettingsPage />);

      const hours = await screen.findByLabelText('Abandoned upload cleanup (hours)');
      await user.clear(hours);
      await user.type(hours, '721');

      expect(
        await screen.findByText(/whole number of hours between 1 and 720/),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(save).not.toHaveBeenCalled();
    });

    it('shows a save error', async () => {
      setHook({ saveError: 'Someone else changed the system settings' });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByText(/Someone else changed/)).toBeInTheDocument();
    });

    it('shows a saving state', async () => {
      setHook({ isSaving: true });
      render(<TranscriptionSettingsPage />);

      expect(await screen.findByRole('button', { name: /saving/i })).toBeDisabled();
    });
  });

  describe('phone layout', () => {
    it('renders every control at 375px', async () => {
      setViewportWidth(375);
      setHook();
      render(<TranscriptionSettingsPage />);

      // Nothing on this page mounts or unmounts on a breakpoint — the
      // responsive behaviour is `Stack`/`Paper` direction and padding only, so
      // the phone rendering must be the DESKTOP one with the same controls.
      // This is what makes "changes none of the five coupled gates" checkable.
      expect(await screen.findByLabelText('Speech model')).toBeInTheDocument();
      expect(screen.getByLabelText('Default language')).toBeInTheDocument();
      expect(screen.getByLabelText('Playback bitrate (kbit/s)')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /test connection/i })).toBeInTheDocument();
    });

    it('renders the same controls at 375px as at 1440px', async () => {
      setViewportWidth(1440);
      setHook();
      const desktop = render(<TranscriptionSettingsPage />);
      const desktopButtons = (await screen.findAllByRole('button')).map((b) => b.textContent);
      desktop.unmount();

      setViewportWidth(375);
      setHook();
      render(<TranscriptionSettingsPage />);
      const phoneButtons = (await screen.findAllByRole('button')).map((b) => b.textContent);

      expect(phoneButtons).toEqual(desktopButtons);
    });
  });
});
