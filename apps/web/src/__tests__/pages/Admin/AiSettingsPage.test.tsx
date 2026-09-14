/**
 * `/admin/settings/ai` (issue #55, epic #45).
 *
 * =============================================================================
 * THE CENTRAL ASSERTION HERE IS AN ABSENCE
 * =============================================================================
 *
 * Epic #45 has no deployment-wide AI key: every key belongs to an individual
 * user. So this page must expose NO key input, and because that is a designed
 * absence rather than an unwritten feature, it has to be asserted EXPLICITLY —
 * an absence nobody checks is indistinguishable from an absence nobody has got
 * round to filling, and the next contributor to open this file would add the
 * field back in good faith. The `no key field anywhere` block below is the
 * executable form of that decision, and it checks the page's own copy too: the
 * page must SAY why there is no key here, or an administrator goes looking.
 *
 * The service module is mocked rather than the hook, matching
 * `UserAiPage.test.tsx` — the `If-Match` version the hook attaches and the
 * 200-on-failed-probe contract are both worth exercising for real.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

// A PARTIAL MOCK, not a wholesale one (#78). The page and its model editor
// import real constants and pure helpers from this module — `AI_MODEL_BOUNDS`,
// `AI_ALLOWED_MODELS_MAX`, `aiDiscoveryConflictReason` — and stubbing the whole
// module makes those `undefined` at render time, which fails as an unrelated
// crash rather than as an assertion. Only the four network calls are replaced.
vi.mock('../../../services/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../services/ai')>();
  return {
    ...actual,
    getAiSettings: vi.fn(),
    updateAiSettings: vi.fn(),
    testAiReachability: vi.fn(),
    discoverAiModels: vi.fn(),
  };
});

vi.mock('../../../hooks/usePermissions', () => ({
  usePermissions: vi.fn(),
}));

import { render, mockAdminUser } from '../../utils/test-utils';
import AiSettingsPage from '../../../pages/Admin/AiSettingsPage';
import { usePermissions } from '../../../hooks/usePermissions';
import {
  discoverAiModels,
  getAiSettings,
  testAiReachability,
  updateAiSettings,
} from '../../../services/ai';
import type { AiSettingsAdminView } from '../../../services/ai';

const mockUsePermissions = vi.mocked(usePermissions);
const mockGet = vi.mocked(getAiSettings);
const mockUpdate = vi.mocked(updateAiSettings);
const mockTest = vi.mocked(testAiReachability);
const mockDiscover = vi.mocked(discoverAiModels);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

const WRITE = ['system_settings:read', 'system_settings:write'];
const READ_ONLY = ['system_settings:read'];

function setPermissions(granted: string[]) {
  mockUsePermissions.mockReturnValue({
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

const baseView: AiSettingsAdminView = {
  settings: {
    enabled: true,
    provider: 'openai',
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        // OBJECTS, not bare ids (#78). The API normalises a legacy stored
        // `"gpt-4o"` to `{ id: 'gpt-4o' }` on read, so this is the shape the
        // page always receives — whatever is in the database.
        allowedModels: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        defaultModel: 'gpt-4o',
      },
    },
    maxInputTokens: 100_000,
    maxOutputTokens: 4_096,
    requestTimeoutMs: 120_000,
    maxDocumentBytes: 26_214_400,
  },
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      capabilities: {
        // Both permitted models are in the catalogue, so neither row demands
        // the two token numbers — the default fixture is a VALID policy, and a
        // test about something else does not fail on a disabled Save button.
        models: [
          {
            id: 'gpt-4o',
            label: 'GPT-4o',
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_384,
          },
          {
            id: 'gpt-4o-mini',
            label: 'GPT-4o mini',
            contextWindowTokens: 128_000,
            maxOutputTokens: 16_384,
          },
        ],
        streaming: true,
        modelDiscovery: true,
      },
      fieldDescriptors: [],
    },
  ],
  unknownModels: [],
  version: 7,
  updatedAt: '2026-01-05T08:00:00.000Z',
  updatedBy: { id: 'admin-user-id', email: 'admin@example.com' },
};

const renderPage = async () => {
  const result = render(<AiSettingsPage />, {
    wrapperOptions: { user: mockAdminUser },
  });
  await screen.findByRole('heading', { level: 1, name: 'AI' });
  return result;
};

describe('AiSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setPermissions(WRITE);
    mockGet.mockResolvedValue(baseView);
    mockUpdate.mockResolvedValue(baseView);
    mockTest.mockResolvedValue({ ok: true, latencyMs: 55, detail: 'Answered normally.' });
    mockDiscover.mockResolvedValue({ ok: true, detail: 'Listed 1 model.', models: [] });
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ==========================================================================
  // ⚠ NO KEY FIELD ANYWHERE — the absence IS the point, so it is asserted
  // ==========================================================================

  describe('no key field anywhere', () => {
    it('renders no password input at all', async () => {
      const { container } = await renderPage();

      expect(container.querySelector('input[type="password"]')).toBeNull();
    });

    it('renders no field whose label mentions a key, a secret or a token', async () => {
      const { container } = await renderPage();

      // Every label on the page, checked as a set — stronger than probing for
      // one expected name, because a key field added under a creative label
      // ("Credential", "Authorization") would slip past that.
      const labels = [...container.querySelectorAll('label')].map(
        (label) => label.textContent ?? '',
      );
      expect(labels.length).toBeGreaterThan(0);
      for (const label of labels) {
        expect(label).not.toMatch(/api key|secret|token$|password|credential/i);
      }
    });

    it('offers no control for removing or replacing a deployment key', async () => {
      await renderPage();

      expect(screen.queryByRole('button', { name: /remove key/i })).toBeNull();
      expect(screen.queryByRole('button', { name: /replace key/i })).toBeNull();
      // The sibling transcription page's control, which has no counterpart here
      // because there is no credential to probe.
      expect(screen.queryByRole('button', { name: /test connection/i })).toBeNull();
    });

    it('says WHY there is no key here, so an administrator does not go looking', async () => {
      await renderPage();

      expect(
        screen.getByText(/there is no api key on this page, by design/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/every user supplies their own key/i),
      ).toBeInTheDocument();
      // And it points at where the key actually lives.
      expect(screen.getByText(/Settings → AI Provider/)).toBeInTheDocument();
    });

    it('sends no key-shaped field on save', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
      const [body] = mockUpdate.mock.calls[0];
      const serialised = JSON.stringify(body);
      expect(serialised).not.toMatch(/apiKey|api_key|secret|password|credential/i);
    });
  });

  // ==========================================================================
  // Policy — what IS here
  // ==========================================================================

  describe('the policy fields', () => {
    it('renders every policy control the API exposes', async () => {
      await renderPage();

      expect(screen.getByLabelText(/enable ai features/i)).toBeInTheDocument();
      // The form is seeded from the server's response in an effect, so the
      // first value is awaited; everything after it is in the same commit.
      await waitFor(() =>
        expect(screen.getByLabelText(/api base url/i)).toHaveValue(
          'https://api.openai.com/v1',
        ),
      );
      // #78: the textarea is gone. The permitted models are rows in a list,
      // one per model, which is what makes per-model token limits expressible
      // at all — see `AiPermittedModels`' header.
      const permitted = screen.getByRole('list', { name: /permitted models/i });
      expect(within(permitted).getAllByRole('listitem')).toHaveLength(2);
      expect(within(permitted).getByText('gpt-4o')).toBeInTheDocument();
      expect(within(permitted).getByText('gpt-4o-mini')).toBeInTheDocument();
      expect(screen.getByLabelText(/max input tokens/i)).toHaveValue(100_000);
      expect(screen.getByLabelText(/max output tokens/i)).toHaveValue(4_096);
      expect(screen.getByLabelText(/request timeout/i)).toHaveValue(120_000);
      // The document ceiling the API does expose — an AI policy, not a storage one.
      expect(screen.getByLabelText(/max document size/i)).toHaveValue(26_214_400);
    });

    it('saves the model list as objects, replacing it wholesale', async () => {
      const user = userEvent.setup();
      await renderPage();

      // Drop the second permitted model and add one this build has never heard
      // of, with the two numbers that make it budgetable — the flow #78 exists
      // for, and the one the retired textarea could not express.
      await user.click(
        screen.getByRole('button', { name: /stop permitting gpt-4o-mini/i }),
      );
      await user.type(screen.getByLabelText(/^model id$/i), 'gpt-9-turbo');
      await user.type(
        screen.getByLabelText(/context window in tokens for gpt-9-turbo/i),
        '250000',
      );
      await user.type(
        screen.getByLabelText(/maximum output tokens for gpt-9-turbo/i),
        '32768',
      );
      await user.click(screen.getByRole('button', { name: /add model/i }));
      await user.click(screen.getByRole('button', { name: /save changes/i }));

      await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(1));
      const [body, version] = mockUpdate.mock.calls[0];
      // ⚠ ALWAYS OBJECTS. The API accepts a bare id for ever so that old STORED
      // policies stay readable, not as a shorthand a client should use.
      expect(body.providers?.openai?.allowedModels).toEqual([
        { id: 'gpt-4o' },
        { id: 'gpt-9-turbo', contextWindowTokens: 250_000, maxOutputTokens: 32_768 },
      ]);
      // The version travels as `If-Match`, so a concurrent edit 409s rather
      // than being silently overwritten.
      expect(version).toBe(7);
    });

    it('refuses a default model that is not in the permitted list', async () => {
      const user = userEvent.setup();
      await renderPage();

      // Removing the default out from under itself is exactly how this state is
      // reached in practice.
      await user.click(screen.getByRole('button', { name: /stop permitting gpt-4o$/i }));

      expect(
        await screen.findByText(/this model is not in the permitted list/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('refuses a token ceiling outside the API’s own bounds, before sending it', async () => {
      const user = userEvent.setup();
      await renderPage();

      const field = screen.getByLabelText(/max output tokens/i);
      await user.clear(field);
      await user.type(field, '10');

      expect(
        await screen.findByText(/must be a whole number between 64 and 200,000 tokens/i),
      ).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
    });

    it('reports permitted models this build cannot budget for', async () => {
      mockGet.mockResolvedValue({ ...baseView, unknownModels: ['gpt-9-turbo'] });
      await renderPage();

      expect(
        await screen.findByText(/some permitted models cannot be used/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/gpt-9-turbo/)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Gating
  // ==========================================================================

  describe('permission gating', () => {
    it('disables every control for a read-only admin, and says so', async () => {
      setPermissions(READ_ONLY);
      await renderPage();

      expect(screen.getByText(/\(read-only\)/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /save changes/i })).toBeDisabled();
      expect(screen.getByLabelText(/api base url/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /test this url/i })).toBeDisabled();
    });

    it('redirects a user without system_settings:read', async () => {
      // Defence in depth — `App.tsx` wraps the route in `RequirePermission`
      // with this same string; this catches the page mounted from anywhere else.
      setPermissions([]);
      render(<AiSettingsPage />, { wrapperOptions: { user: mockAdminUser } });

      await waitFor(() =>
        expect(screen.queryByRole('heading', { level: 1, name: 'AI' })).toBeNull(),
      );
    });
  });

  // ==========================================================================
  // The reachability probe — 200 on failure, like its credential sibling
  // ==========================================================================

  describe('testing the base URL', () => {
    it('probes the URL typed into the form, not the saved one, and sends no credential', async () => {
      const user = userEvent.setup();
      await renderPage();

      const field = screen.getByLabelText(/api base url/i);
      await user.clear(field);
      await user.type(field, 'https://gateway.example.com/v1');
      await user.click(screen.getByRole('button', { name: /test this url/i }));

      await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
      expect(mockTest).toHaveBeenCalledWith({ baseUrl: 'https://gateway.example.com/v1' });
      // One field, and nothing else: there is no deployment key to send.
      expect(Object.keys(mockTest.mock.calls[0][0])).toEqual(['baseUrl']);
      expect(mockUpdate).not.toHaveBeenCalled();
    });

    it('renders a 200 { ok: false } as a diagnosis, not a thrown error', async () => {
      const user = userEvent.setup();
      mockTest.mockResolvedValue({
        ok: false,
        latencyMs: 30,
        detail: 'The host answered, but not on this path — check for a missing /v1.',
      });
      await renderPage();

      await user.click(screen.getByRole('button', { name: /test this url/i }));

      expect(
        await screen.findByText(/the host answered, but not on this path/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/the endpoint did not answer as expected/i),
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Accessibility, in both themes
  // ==========================================================================

  describe('accessibility', () => {
    it('passes axe in the light theme', async () => {
      localStorage.setItem('theme_mode', 'light');
      const { container } = await renderPage();

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme', async () => {
      localStorage.setItem('theme_mode', 'dark');
      const { container } = await renderPage();

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
