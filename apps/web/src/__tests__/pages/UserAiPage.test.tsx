/**
 * `/settings/ai` (issue #55, epic #45).
 *
 * THE SERVICE MODULE IS MOCKED, NOT THE HOOKS — deliberately the opposite
 * choice from `EmailSettingsPage.test.tsx`. Two of this issue's acceptance
 * criteria are statements about the HOOK's behaviour as much as the page's:
 *
 *   • a `200 { ok: false }` from `POST /ai-credentials/test` must render as a
 *     diagnosis rather than throw, and
 *   • testing an unsaved key must not save it,
 *
 * and both are only really proven when the real `useAiCredential` sits between
 * the mocked transport and the rendered page. Mocking the hook would let this
 * suite pass over a hook that threw on every refusal.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

vi.mock('../../services/ai', () => ({
  getAiConfig: vi.fn(),
  getAiCredentials: vi.fn(),
  saveAiCredential: vi.fn(),
  testAiCredential: vi.fn(),
  removeAiCredential: vi.fn(),
}));

import { render } from '../utils/test-utils';
import UserAiPage from '../../pages/UserAiPage';
import {
  getAiConfig,
  getAiCredentials,
  removeAiCredential,
  saveAiCredential,
  testAiCredential,
} from '../../services/ai';
import type { AiConfig, AiCredentialStatus } from '../../services/ai';

const mockGetConfig = vi.mocked(getAiConfig);
const mockGetCredentials = vi.mocked(getAiCredentials);
const mockSave = vi.mocked(saveAiCredential);
const mockTest = vi.mocked(testAiCredential);
const mockRemove = vi.mocked(removeAiCredential);

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

/** A value that must never reach the DOM. Distinctive so a substring search is meaningful. */
const RAW_KEY = 'sk-live-THIS-MUST-NEVER-RENDER-9f8e7d';

const baseConfig: AiConfig = {
  available: true,
  provider: 'openai',
  providerLabel: 'OpenAI',
  models: [
    { id: 'gpt-4o', label: 'GPT-4o', contextWindowTokens: 128_000, maxOutputTokens: 4_096 },
  ],
  defaultModel: 'gpt-4o',
  maxInputTokens: 100_000,
  maxOutputTokens: 4_096,
  keyConfigured: false,
};

const storedStatus: AiCredentialStatus = {
  provider: 'openai',
  configured: true,
  hint: '••••7d9f',
  label: null,
  lastUsedAt: '2026-02-03T10:00:00.000Z',
  updatedAt: '2026-01-02T09:00:00.000Z',
};

function setup(options: { config?: Partial<AiConfig>; stored?: boolean } = {}) {
  mockGetConfig.mockResolvedValue({
    ...baseConfig,
    keyConfigured: options.stored ?? false,
    ...options.config,
  });
  mockGetCredentials.mockResolvedValue({
    credentials: options.stored ? [storedStatus] : [],
  });
}

/** Wait past the two initial reads so the page is showing its real content. */
async function renderPage() {
  const result = render(<UserAiPage />);
  await screen.findByRole('heading', { level: 1, name: 'AI Provider' });
  return result;
}

describe('UserAiPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    setup();
    mockSave.mockResolvedValue(storedStatus);
    mockTest.mockResolvedValue({ ok: true, latencyMs: 120, detail: 'The key works.' });
    mockRemove.mockResolvedValue(undefined);
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ==========================================================================
  // The three questions the page must answer without being asked
  // ==========================================================================

  describe('the three questions', () => {
    it('says plainly that this is the user’s own account and their own spend', async () => {
      await renderPage();

      // In the page's own voice, at the top — not buried in helper text under
      // a field, which is the failure mode the issue calls out.
      expect(
        screen.getByText(/this is your own account, and your own spend/i),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/this application has no ai key of its own and never falls back/i),
      ).toBeInTheDocument();
    });

    it('links to where a key is obtained, on the provider’s own site', async () => {
      await renderPage();

      const link = screen.getByRole('link', { name: /get a key from openai/i });
      expect(link).toHaveAttribute('href', 'https://platform.openai.com/api-keys');
      // A cross-origin link opened in a new tab, so `noreferrer` is required
      // rather than cosmetic.
      expect(link).toHaveAttribute('rel', expect.stringContaining('noreferrer'));
    });

    it('names what leaves the deployment on a generation, and which provider receives it', async () => {
      await renderPage();

      const section = screen.getByRole('heading', { name: /what is sent, and to whom/i })
        .parentElement as HTMLElement;
      // "a third party" is an evasion; the provider is named.
      expect(within(section).getAllByText(/OpenAI/).length).toBeGreaterThan(0);
      expect(within(section).getByText(/audio is never sent/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ⚠ The raw key never reaches the DOM
  // ==========================================================================

  describe('the raw key never appears in the DOM', () => {
    // TWO DISTINCT CLAIMS, and it matters that they are not conflated:
    //
    //   (a) the key is NEVER RENDERED — it never becomes text a person, a
    //       screenshot, a screen reader or a copy-paste could pick up. That
    //       must hold at every moment, the one while it is being typed
    //       included, which is why it is asserted against `textContent`.
    //   (b) once it is stored, it is GONE — not merely hidden. That is the
    //       stronger claim, so it is asserted against the serialised markup,
    //       input values and all.
    //
    // While the user is typing, the characters are of course inside the input
    // element they are typing into; a test asserting otherwise would be
    // asserting the field does not work. What must hold there is (a).

    it('is never rendered as text, and is gone entirely once stored', async () => {
      const user = userEvent.setup();
      await renderPage();

      expect(document.body.textContent).not.toContain(RAW_KEY);

      const field = screen.getByLabelText(/^API key$/i);
      // A password field, so the characters are never displayed even while the
      // user is typing them.
      expect(field).toHaveAttribute('type', 'password');

      await user.type(field, RAW_KEY);
      expect(document.body.textContent).not.toContain(RAW_KEY);

      await user.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
      // It travelled in the request body — which is the one place it belongs.
      expect(mockSave).toHaveBeenCalledWith({ provider: 'openai', apiKey: RAW_KEY });

      // (b): after the save it is nowhere in the document at all — the draft is
      // cleared and the field unmounted, so there is no element left holding it.
      await screen.findByText(/••••7d9f/);
      expect(document.body.innerHTML).not.toContain(RAW_KEY);
      expect(document.body.textContent).not.toContain(RAW_KEY);
    });

    it('is not rendered by a probe, whose response is shown in full', async () => {
      const user = userEvent.setup();
      mockTest.mockResolvedValue({ ok: true, latencyMs: 91, detail: 'The key works.' });
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /test key/i }));

      // The result is rendered; the key that produced it is not echoed into it.
      await screen.findByText(/your key works/i);
      expect(document.body.textContent).not.toContain(RAW_KEY);
    });

    it('clears the draft once the key is stored, so it cannot be resubmitted or read back', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /save key/i }));

      // The field is gone entirely once a key is stored — the page describes
      // what is held rather than offering an empty secret-looking box.
      await waitFor(() =>
        expect(screen.queryByLabelText(/^API key$/i)).not.toBeInTheDocument(),
      );
      expect(document.querySelector('input[type="password"]')).toBeNull();
    });
  });

  // ==========================================================================
  // The masked status
  // ==========================================================================

  describe('the stored key is described, never shown', () => {
    it('renders the mask, the saved date and the last-used date', async () => {
      setup({ stored: true });
      await renderPage();

      expect(await screen.findByText(/••••7d9f/)).toBeInTheDocument();
      expect(screen.getByText(/was saved on/i)).toBeInTheDocument();
      expect(screen.getByText(/last used/i)).toBeInTheDocument();
      expect(screen.getByText('Key saved')).toBeInTheDocument();
    });

    it('hides the key field until Replace is pressed', async () => {
      const user = userEvent.setup();
      setup({ stored: true });
      await renderPage();

      await screen.findByText(/••••7d9f/);
      expect(screen.queryByLabelText(/^API key$/i)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: /replace key/i }));

      const field = screen.getByLabelText(/^API key$/i);
      expect(field).toHaveAttribute('type', 'password');
      expect(field).toHaveValue('');
      // Blank preserves: the helper text has to say so, because an empty box
      // over a stored secret is otherwise ambiguous.
      expect(screen.getByText(/leave this empty to keep the key you already saved/i)).toBeInTheDocument();
    });

    it('says so plainly when nothing is stored', async () => {
      await renderPage();

      expect(screen.getByText(/no api key is stored for your account/i)).toBeInTheDocument();
      expect(screen.getByText('No key')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // ⚠ A refused probe is a DIAGNOSIS, not an error
  // ==========================================================================

  describe('testing a key', () => {
    it('renders a 200 { ok: false } as the provider’s own diagnosis, never as a thrown error', async () => {
      const user = userEvent.setup();
      // The endpoint's documented refusal shape: HTTP 200, `ok: false`, and a
      // `detail` naming which of three different fixes applies.
      mockTest.mockResolvedValue({
        ok: false,
        latencyMs: 210,
        detail: 'Your provider rejected this key (401). Check that you copied it in full.',
      });
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /test key/i }));

      // The DETAIL is rendered, verbatim — not "test failed", not a toast.
      expect(
        await screen.findByText(
          /your provider rejected this key \(401\)\. check that you copied it in full\./i,
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/your provider did not accept this key/i),
      ).toBeInTheDocument();
      // And it is not dressed as a failure of the application: the probe did
      // its job, which was to find this out.
      expect(screen.queryByText(/could not save your key/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/the test request could not be sent/i)).not.toBeInTheDocument();
    });

    it('tests the key typed into the form WITHOUT saving it', async () => {
      const user = userEvent.setup();
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /test key/i }));

      await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
      expect(mockTest).toHaveBeenCalledWith({ provider: 'openai', apiKey: RAW_KEY });
      // THE POINT OF THE CONTROL: nothing was committed.
      expect(mockSave).not.toHaveBeenCalled();
      // And the field still holds the draft, so a user who liked the answer
      // can save it without retyping.
      expect(screen.getByLabelText(/^API key$/i)).toHaveValue(RAW_KEY);
    });

    it('falls back to the stored key when the box is empty', async () => {
      const user = userEvent.setup();
      setup({ stored: true });
      await renderPage();

      await screen.findByText(/••••7d9f/);
      await user.click(screen.getByRole('button', { name: /test key/i }));

      await waitFor(() => expect(mockTest).toHaveBeenCalledTimes(1));
      // `undefined`, never `''`: the API reads an absent key as "use the one
      // you have stored", which is how "is last month's key still valid?" is
      // asked.
      expect(mockTest).toHaveBeenCalledWith({ provider: 'openai', apiKey: undefined });
    });

    it('renders a genuine transport failure in the same region, still without throwing', async () => {
      const user = userEvent.setup();
      mockTest.mockRejectedValue(new Error('network down'));
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /test key/i }));

      // One region for both kinds of failure, so the page has no way to read
      // a resolved promise as a successful probe.
      expect(
        await screen.findByText(/the test request could not be sent/i),
      ).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Saving, replacing and removing
  // ==========================================================================

  describe('saving and replacing', () => {
    it('will not submit an empty key', async () => {
      await renderPage();

      expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
    });

    it('re-reads the capability probe after a save, so other AI surfaces unlock', async () => {
      const user = userEvent.setup();
      await renderPage();

      expect(mockGetConfig).toHaveBeenCalledTimes(1);

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /save key/i }));

      // `keyConfigured` lives on a DIFFERENT endpoint from the credential, so
      // it is re-read rather than inferred — otherwise a user could save a key
      // and still be told to add one.
      await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(2));
    });

    it('replaces a stored key with the newly typed one', async () => {
      const user = userEvent.setup();
      setup({ stored: true });
      await renderPage();

      await screen.findByText(/••••7d9f/);
      await user.click(screen.getByRole('button', { name: /replace key/i }));
      await user.type(screen.getByLabelText(/^API key$/i), 'sk-replacement-key');
      await user.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
      expect(mockSave).toHaveBeenCalledWith({
        provider: 'openai',
        apiKey: 'sk-replacement-key',
      });
    });

    it('renders a save failure as a message on the page, not as a crash', async () => {
      const user = userEvent.setup();
      const { ApiError } = await import('../../services/api');
      mockSave.mockRejectedValue(new ApiError('Unknown provider', 400));
      await renderPage();

      await user.type(screen.getByLabelText(/^API key$/i), RAW_KEY);
      await user.click(screen.getByRole('button', { name: /save key/i }));

      expect(await screen.findByText(/could not save your key/i)).toBeInTheDocument();
      expect(screen.getByText('Unknown provider')).toBeInTheDocument();
    });
  });

  describe('removing', () => {
    it('confirms before erasing, and does nothing if the confirmation is dismissed', async () => {
      const user = userEvent.setup();
      setup({ stored: true });
      await renderPage();

      await screen.findByText(/••••7d9f/);
      await user.click(screen.getByRole('button', { name: /remove key/i }));

      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText(/remove your api key\?/i)).toBeInTheDocument();
      // The page is honest about why this cannot simply be undone.
      expect(
        within(dialog).getByText(/cannot show you the key it is holding/i),
      ).toBeInTheDocument();

      await user.click(within(dialog).getByRole('button', { name: /cancel/i }));

      expect(mockRemove).not.toHaveBeenCalled();
    });

    it('erases the key once confirmed, and re-reads the capability probe', async () => {
      const user = userEvent.setup();
      setup({ stored: true });
      await renderPage();

      await screen.findByText(/••••7d9f/);
      await user.click(screen.getByRole('button', { name: /remove key/i }));

      const dialog = await screen.findByRole('dialog');
      // After the confirmation the list is re-read from the server rather than
      // guessed at locally — a 204 carries no body to adopt.
      mockGetCredentials.mockResolvedValue({ credentials: [] });
      await user.click(within(dialog).getByRole('button', { name: /remove key/i }));

      await waitFor(() => expect(mockRemove).toHaveBeenCalledWith('openai'));
      await waitFor(() => expect(mockGetConfig).toHaveBeenCalledTimes(2));
      expect(await screen.findByText(/no api key is stored for your account/i)).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // The deployment has not configured AI yet
  // ==========================================================================

  describe('when no provider is configured', () => {
    it('says the key is not the missing piece, and offers nothing to save', async () => {
      setup({ config: { provider: null, providerLabel: null, available: false } });
      await renderPage();

      expect(
        screen.getByText(/ai is not set up on this deployment yet/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/your key is not the missing piece/i)).toBeInTheDocument();
      // The field is rendered but inert: there is no provider id to save it
      // against, and a Save that 400s would be worse than a disabled one.
      expect(screen.getByLabelText(/^API key$/i)).toBeDisabled();
      expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
      // #83: this is the ONE state where the original warning is true, and the
      // new "not switched on yet" notice — which presumes a vendor IS chosen —
      // must not also render here.
      expect(
        screen.queryByText(/ai is not switched on yet — your key is still worth adding/i),
      ).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // #83: a vendor IS chosen, but the deployment has not switched AI on yet
  // ==========================================================================
  //
  // This is the fresh-deployment state that #83 was actually filed about:
  // `ai.provider` defaults to `'openai'` and `ai.enabled` defaults to `false`,
  // so `provider !== null && !available` is what every new deployment starts
  // in — not the `provider === null` case above, which the old code (wrongly)
  // treated as the only "AI isn't ready" state. The old warning
  // ("An administrator has not chosen an AI provider […] your key is not the
  // missing piece") was FALSE here, and it is the sentence that misdirected
  // the original report.

  describe('#83: a provider is chosen but AI is not switched on yet', () => {
    it('leaves the key form fully usable — field, Save once typed, and Test — and saves against the chosen provider', async () => {
      const user = userEvent.setup();
      setup({ config: { available: false } }); // provider: 'openai', providerLabel: 'OpenAI' (baseConfig)
      await renderPage();

      const field = screen.getByLabelText(/^API key$/i);
      expect(field).toBeEnabled();
      // Nothing typed yet — Save is disabled for the ordinary "empty box"
      // reason, not because the deployment isn't ready.
      expect(screen.getByRole('button', { name: /save key/i })).toBeDisabled();
      expect(screen.getByRole('button', { name: /test key/i })).toBeEnabled();

      await user.type(field, RAW_KEY);
      expect(screen.getByRole('button', { name: /save key/i })).toBeEnabled();

      await user.click(screen.getByRole('button', { name: /save key/i }));

      await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1));
      expect(mockSave).toHaveBeenCalledWith({ provider: 'openai', apiKey: RAW_KEY });
    });

    it('renders the new info notice, and NOT the old "no provider" warning', async () => {
      setup({ config: { available: false } });
      await renderPage();

      expect(
        await screen.findByText(/ai is not switched on yet — your key is still worth adding/i),
      ).toBeInTheDocument();
      expect(screen.getByText(/an administrator has chosen openai/i)).toBeInTheDocument();
      // The false claim that misdirected the original report must be absent,
      // not merely unasserted — a provider genuinely IS chosen here.
      expect(
        screen.queryByText(/an administrator has not chosen an ai provider/i),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(/your key is not the missing piece/i),
      ).not.toBeInTheDocument();
    });
  });

  // ==========================================================================
  // Accessibility, in both themes
  // ==========================================================================

  describe('accessibility', () => {
    it('passes axe in the light theme with a key stored', async () => {
      localStorage.setItem('theme_mode', 'light');
      setup({ stored: true });
      const { container } = await renderPage();
      await screen.findByText(/••••7d9f/);

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });

    it('passes axe in the dark theme with no key stored', async () => {
      localStorage.setItem('theme_mode', 'dark');
      const { container } = await renderPage();
      await screen.findByLabelText(/^API key$/i);

      expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
    });
  });
});
