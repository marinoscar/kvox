import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { ThemeProvider } from '@mui/material/styles';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { axe } from 'vitest-axe';
import 'vitest-axe/extend-expect';

import { COPILOT_CONSENT_VERSION } from '@marinoscar/kvox-contract/copilot';
import type { CopilotSignInChallenge } from '@marinoscar/kvox-contract/copilot';

import { kvoxDarkTheme, kvoxLightTheme } from '../../src/brand/index.js';
import { COPILOT_CONSENT_COPY, COPILOT_PROVIDER_COPY } from '../../src/copilot/headless/index.js';
import { CopilotProviderCard } from '../../src/copilot/ui/index.js';
import type { CopilotProviderCardProps } from '../../src/copilot/ui/index.js';
import { consentedSettings, makeSettings, makeStatus, SIGNED_IN } from './copilotData.js';

const AXE_OPTIONS = { rules: { 'color-contrast': { enabled: false } } };

function props(overrides: Partial<CopilotProviderCardProps> = {}): CopilotProviderCardProps {
  return {
    status: makeStatus(),
    settings: makeSettings(),
    onUpdate: vi.fn().mockResolvedValue(undefined),
    onSignIn: vi.fn(),
    onWaitForSignIn: vi.fn(),
    onSignOut: vi.fn().mockResolvedValue(undefined),
    onOpenExternal: vi.fn(),
    ...overrides,
  };
}

function renderCard(p: CopilotProviderCardProps, mode: 'light' | 'dark' = 'light') {
  const theme = mode === 'dark' ? kvoxDarkTheme : kvoxLightTheme;
  const ui = (next: CopilotProviderCardProps): ReactElement => (
    <ThemeProvider theme={theme}>
      <CopilotProviderCard {...next} />
    </ThemeProvider>
  );
  const utils = render(ui(p));
  return { ...utils, rerenderCard: (next: CopilotProviderCardProps) => utils.rerender(ui(next)) };
}

const DEVICE: CopilotSignInChallenge = {
  kind: 'device',
  userCode: 'ABCD-1234',
  verificationUri: 'https://github.com/login/device',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CopilotProviderCard: off by default', () => {
  it('shows only the title and the switch, and no status or models', () => {
    renderCard(props({ status: makeStatus({ ...SIGNED_IN }) }));
    expect(screen.getByRole('heading', { name: 'GitHub Copilot' })).toBeInTheDocument();
    const toggle = screen.getByRole('switch', { name: 'Enable GitHub Copilot' });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
  });
});

describe('CopilotProviderCard: the consent gate', () => {
  it('opens the consent dialog and saves nothing until the user accepts', async () => {
    const user = userEvent.setup();
    const p = props();
    renderCard(p);

    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));

    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(p.onUpdate).not.toHaveBeenCalled();
    expect(within(dialog).getByText(/note and transcript text, is sent to GitHub Copilot/)).toBeInTheDocument();
    expect(within(dialog).getByText(/name checks and Ask run on GitHub Copilot/)).toBeInTheDocument();
    expect(within(dialog).queryByText(/Add an OpenAI key to keep Ask/)).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Agree and turn on' }));

    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledTimes(1));
    expect(p.onUpdate).toHaveBeenCalledWith({
      enabled: true,
      consentedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      consentVersion: COPILOT_CONSENT_VERSION,
    });
  });

  it('links GitHub’s terms and the Copilot privacy page', async () => {
    const user = userEvent.setup();
    renderCard(props());
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog');
    const terms = within(dialog).getByRole('link', { name: /GitHub terms for additional products and features/ });
    expect(terms).toHaveAttribute(
      'href',
      'https://docs.github.com/en/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot',
    );
    expect(within(dialog).getByRole('link', { name: /Responsible use of GitHub Copilot features/ })).toHaveAttribute(
      'href',
      'https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features',
    );
  });

  it('opens a link through onOpenExternal when the host provides one', async () => {
    const user = userEvent.setup();
    const p = props();
    renderCard(p);
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    await user.click(await screen.findByRole('link', { name: /Responsible use of GitHub Copilot features/ }));
    expect(p.onOpenExternal).toHaveBeenCalledWith(
      'https://docs.github.com/en/copilot/responsible-use-of-github-copilot-features',
    );
  });

  it('"Not now" closes the dialog, saves nothing and leaves the switch off', async () => {
    const user = userEvent.setup();
    const p = props();
    renderCard(p);
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(p.onUpdate).not.toHaveBeenCalled();
    expect(screen.getByRole('switch', { name: 'Enable GitHub Copilot' })).not.toBeChecked();
  });

  it('shows the download size in the consent while the runtime is missing, and not when it is ready', async () => {
    const user = userEvent.setup();
    const { unmount } = renderCard(
      props({ status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }) }),
    );
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    expect(await screen.findByText(/runtime of about 130 to 175 MB/)).toBeInTheDocument();
    unmount();

    renderCard(props());
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    await screen.findByRole('dialog');
    expect(screen.queryByText(/runtime of/)).not.toBeInTheDocument();
  });

  it('states the host’s exact download size when it passes one', async () => {
    const user = userEvent.setup();
    renderCard(
      props({
        status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
        runtimeDownloadSize: '151 MB',
      }),
    );
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    expect(await screen.findByText(/runtime of 151 MB/)).toBeInTheDocument();
  });

  it('asks again when the stored consent version differs from the current one', async () => {
    const user = userEvent.setup();
    const p = props({ settings: consentedSettings({ consentVersion: '0' }) });
    renderCard(p);

    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Agree and turn on' }));
    await waitFor(() =>
      expect(p.onUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true, consentVersion: COPILOT_CONSENT_VERSION }),
      ),
    );
  });

  it('declining a re-consent turns Copilot off', async () => {
    const user = userEvent.setup();
    const p = props({ settings: consentedSettings({ consentVersion: '0' }) });
    renderCard(p);
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith({ enabled: false }));
  });

  it('does not ask again for a consent already given at the current version', async () => {
    const user = userEvent.setup();
    const p = props({ settings: consentedSettings({ enabled: false }) });
    renderCard(p);
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith({ enabled: true }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('CopilotProviderCard: turning off', () => {
  it('calls onUpdate({ enabled: false }) and hides the status and models once the setting is off', async () => {
    const user = userEvent.setup();
    const status = makeStatus({ ...SIGNED_IN });
    const p = props({ status, settings: consentedSettings() });
    const { rerenderCard } = renderCard(p);
    expect(screen.getByText('Signed in as octocat')).toBeInTheDocument();

    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith({ enabled: false }));

    rerenderCard({ ...p, settings: consentedSettings({ enabled: false }) });
    expect(screen.queryByText('Signed in as octocat')).not.toBeInTheDocument();
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
  });

  it('withdraws consent entirely from the signed-in card', async () => {
    const user = userEvent.setup();
    const p = props({ status: makeStatus({ ...SIGNED_IN }), settings: consentedSettings() });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Withdraw consent' }));
    await waitFor(() =>
      expect(p.onUpdate).toHaveBeenCalledWith({ enabled: false, consentedAt: null, consentVersion: null }),
    );
  });
});

describe('CopilotProviderCard: sign-in', () => {
  it('device flow: shows the code, opens GitHub, then waits and closes when the wait resolves', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    renderCard(p);

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));

    const dialog = await screen.findByRole('dialog', { name: 'Sign in to GitHub Copilot' });
    expect(within(dialog).getByText('ABCD-1234')).toBeInTheDocument();
    expect(p.onWaitForSignIn).toHaveBeenCalledWith(expect.any(AbortSignal));

    await user.click(within(dialog).getByRole('button', { name: 'Open GitHub' }));
    expect(p.onOpenExternal).toHaveBeenCalledWith('https://github.com/login/device');

    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('copies the device code', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(() => new Promise<void>(() => undefined)),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await user.click(await screen.findByRole('button', { name: 'Copy code' }));
    expect(writeText).toHaveBeenCalledWith('ABCD-1234');
    expect(await screen.findByText('Code copied.')).toBeInTheDocument();
  });

  it('browser flow: opens the address through the host and shows the hand-off', async () => {
    const user = userEvent.setup();
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue({ kind: 'browser', url: 'https://github.com/login/oauth/authorize?x=1' }),
      onWaitForSignIn: vi.fn(() => new Promise<void>(() => undefined)),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Finish signing in with GitHub in your browser/)).toBeInTheDocument();
    expect(p.onOpenExternal).toHaveBeenCalledWith('https://github.com/login/oauth/authorize?x=1');
  });

  it('opens a browser address with window.open when the host gives no opener', async () => {
    const user = userEvent.setup();
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const p = props({
      settings: consentedSettings(),
      onOpenExternal: undefined,
      onSignIn: vi.fn().mockResolvedValue({ kind: 'browser', url: 'https://github.com/login/oauth/authorize' }),
      onWaitForSignIn: vi.fn(() => new Promise<void>(() => undefined)),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await screen.findByRole('dialog');
    expect(open).toHaveBeenCalledWith('https://github.com/login/oauth/authorize', '_blank', 'noopener,noreferrer');
  });

  it('never opens an address that is not https', async () => {
    const user = userEvent.setup();
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue({ kind: 'browser', url: 'http://example.com/login' }),
      onWaitForSignIn: vi.fn(() => new Promise<void>(() => undefined)),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await screen.findByRole('dialog');
    expect(p.onOpenExternal).not.toHaveBeenCalled();
  });

  it('Cancel aborts the wait and closes the dialog without an error', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(
        (s: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal = s;
            s.addEventListener('abort', () => reject(new Error('sign_in_cancelled')));
          }),
      ),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' })).toBeEnabled();
  });

  it('words a failed sign-in by its signInReason', async () => {
    const user = userEvent.setup();
    const failure = Object.assign(new Error('AI_KEY_REQUIRED'), { details: { signInReason: 'sign_in_expired' } });
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn().mockRejectedValue(failure),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    expect(await screen.findByText('The sign-in took too long and was cancelled. Try again.')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a readable error when the sign-in cannot start', async () => {
    const user = userEvent.setup();
    const p = props({
      settings: consentedSettings(),
      onSignIn: vi.fn().mockRejectedValue(new Error('The runtime did not start.')),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    expect(await screen.findByText('The runtime did not start.')).toBeInTheDocument();
    expect(p.onWaitForSignIn).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', /^Download the Copilot runtime first \(about 130 to 175 MB\)\.$/],
    ['downloading', /^Wait for the Copilot runtime to finish downloading\.$/],
    ['error', /^The Copilot runtime is not working\. Download it again first\.$/],
  ] as const)('runtime %s: Sign in is disabled and the reason is shown and described-by', async (state, text) => {
    const p = props({
      settings: consentedSettings(),
      status: makeStatus({ runtime: { state, version: null, progress: null } }),
    });
    renderCard(p);
    const button = screen.getByRole('button', { name: 'Sign in with GitHub Copilot' });
    expect(button).toBeDisabled();
    const reason = screen.getByText(text);
    expect(reason).toBeVisible();
    expect(reason.id).not.toBe('');
    expect(button.getAttribute('aria-describedby')?.split(/\s+/)).toContain(reason.id);
    expect(button).toHaveAccessibleDescription(text);
    fireEvent.click(button);
    expect(p.onSignIn).not.toHaveBeenCalled();
  });

  it('states the host’s download size in the reason while the runtime is missing', () => {
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
        runtimeDownloadSize: '151 MB',
      }),
    );
    expect(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' })).toHaveAccessibleDescription(
      'Download the Copilot runtime first (151 MB).',
    );
  });

  it('runtime ready: Sign in is enabled with no reason', () => {
    renderCard(props({ settings: consentedSettings() }));
    const button = screen.getByRole('button', { name: 'Sign in with GitHub Copilot' });
    expect(button).toBeEnabled();
    expect(button).not.toHaveAttribute('aria-describedby');
    expect(screen.queryByText(/Download the Copilot runtime first/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Wait for the Copilot runtime/)).not.toBeInTheDocument();
    expect(screen.queryByText(/is not working/)).not.toBeInTheDocument();
  });

  it('enables Sign in once the runtime becomes ready', async () => {
    const user = userEvent.setup();
    const p = props({
      settings: consentedSettings(),
      status: makeStatus({ runtime: { state: 'downloading', version: null, progress: 0.5 } }),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(() => new Promise<void>(() => undefined)),
    });
    const { rerenderCard } = renderCard(p);
    expect(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' })).toBeDisabled();
    rerenderCard({ ...p, status: makeStatus() });
    const button = screen.getByRole('button', { name: 'Sign in with GitHub Copilot' });
    expect(button).toBeEnabled();
    await user.click(button);
    expect(p.onSignIn).toHaveBeenCalledTimes(1);
  });

  it('shows the signed-in chip with the login, the models and the model choice', async () => {
    const user = userEvent.setup();
    const p = props({ settings: consentedSettings({ model: 'gpt-5' }), status: makeStatus({ ...SIGNED_IN }) });
    renderCard(p);
    expect(screen.getByText('Signed in as octocat')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();

    await user.click(screen.getByRole('combobox', { name: /Model/ }));
    await user.click(await screen.findByRole('option', { name: 'Claude Sonnet' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith({ model: 'claude-sonnet' }));
  });
});

describe('CopilotProviderCard: the host selects the provider', () => {
  function expectNoSwitch() {
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Enable GitHub Copilot')).not.toBeInTheDocument();
  }

  it('selected undefined: the card keeps its own switch', () => {
    renderCard(props());
    expect(screen.getByRole('switch', { name: 'Enable GitHub Copilot' })).toBeInTheDocument();
  });

  it('selected false: renders only the header, with no switch', () => {
    renderCard(props({ selected: false, settings: consentedSettings(), status: makeStatus({ ...SIGNED_IN }) }));
    expect(screen.getByRole('heading', { name: 'GitHub Copilot' })).toBeInTheDocument();
    expectNoSwitch();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/Signed in as/)).not.toBeInTheDocument();
    expect(screen.queryByText('Model')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Withdraw consent' })).not.toBeInTheDocument();
  });

  it('selected true and not consented: no switch, and the consent dialog opens at once', async () => {
    const p = props({ selected: true, onDecline: vi.fn() });
    renderCard(p);
    expectNoSwitch();
    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(within(dialog).getByText(/note and transcript text, is sent to GitHub Copilot/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sign in with/ })).not.toBeInTheDocument();
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it('selected true: Not now calls onDecline and saves nothing', async () => {
    const user = userEvent.setup();
    const onDecline = vi.fn();
    const p = props({ selected: true, onDecline });
    renderCard(p);
    await user.click(await screen.findByRole('button', { name: 'Not now' }));
    await waitFor(() => expect(onDecline).toHaveBeenCalledTimes(1));
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it('selected true: Not now waits for an async onDecline', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const onDecline = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const p = props({ selected: true, onDecline });
    renderCard(p);
    const notNow = await screen.findByRole('button', { name: 'Not now' });
    await user.click(notNow);
    expect(onDecline).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(notNow).toBeDisabled());
    await act(async () => finish());
    expect(p.onUpdate).not.toHaveBeenCalled();
  });

  it('selected true without onDecline: the consent dialog offers no Not now', async () => {
    renderCard(props({ selected: true }));
    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(within(dialog).queryByRole('button', { name: 'Not now' })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Agree and use GitHub Copilot' })).toBeInTheDocument();
  });

  it('selected true: Accept calls onUpdate with the consent', async () => {
    const user = userEvent.setup();
    const onDecline = vi.fn();
    const p = props({ selected: true, onDecline });
    renderCard(p);
    await user.click(await screen.findByRole('button', { name: 'Agree and use GitHub Copilot' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledTimes(1));
    expect(p.onUpdate).toHaveBeenCalledWith({
      enabled: true,
      consentedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      consentVersion: COPILOT_CONSENT_VERSION,
    });
    expect(onDecline).not.toHaveBeenCalled();
  });

  it('selected true: a stale consent version asks again even when the setting is off', async () => {
    renderCard(props({ selected: true, settings: consentedSettings({ enabled: false, consentVersion: '0' }) }));
    expect(await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title })).toBeInTheDocument();
    expectNoSwitch();
  });

  it('selected true and consented: the sign-in flow runs as usual', async () => {
    const user = userEvent.setup();
    let finish: () => void = () => undefined;
    const p = props({
      selected: true,
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(() => new Promise<void>((resolve) => (finish = resolve))),
    });
    renderCard(p);
    expectNoSwitch();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sign in to GitHub Copilot' });
    expect(within(dialog).getByText('ABCD-1234')).toBeInTheDocument();
    finish();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('selected true and consented: Sign in is disabled with the runtime reason while the runtime is missing', () => {
    const p = props({
      selected: true,
      settings: consentedSettings({ enabled: false }),
      status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
    });
    renderCard(p);
    const button = screen.getByRole('button', { name: 'Sign in with GitHub Copilot' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Download the Copilot runtime first (about 130 to 175 MB).');
    fireEvent.click(button);
    expect(p.onSignIn).not.toHaveBeenCalled();
  });

  it('selected true and signed in: Withdraw consent still calls onUpdate with the cleared consent', async () => {
    const user = userEvent.setup();
    const p = props({ selected: true, settings: consentedSettings(), status: makeStatus({ ...SIGNED_IN }) });
    renderCard(p);
    expectNoSwitch();
    expect(screen.getByText('Signed in as octocat')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Withdraw consent' }));
    await waitFor(() =>
      expect(p.onUpdate).toHaveBeenCalledWith({ enabled: false, consentedAt: null, consentVersion: null }),
    );
  });

  it('deselecting stops a sign-in in progress', async () => {
    const user = userEvent.setup();
    let signal: AbortSignal | undefined;
    const p = props({
      selected: true,
      settings: consentedSettings(),
      onSignIn: vi.fn().mockResolvedValue(DEVICE),
      onWaitForSignIn: vi.fn(
        (s: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal = s;
            s.addEventListener('abort', () => reject(new Error('sign_in_cancelled')));
          }),
      ),
    });
    const { rerenderCard } = renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await screen.findByRole('dialog', { name: 'Sign in to GitHub Copilot' });

    rerenderCard({ ...p, selected: false });
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(signal?.aborted).toBe(true);
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s mode, selected and signed in', async (mode) => {
    const { container } = renderCard(
      props({ selected: true, settings: consentedSettings({ model: 'gpt-5' }), status: makeStatus({ ...SIGNED_IN }) }),
      mode,
    );
    expect(await axe(container, AXE_OPTIONS)).toHaveNoViolations();
  });
});

describe('CopilotProviderCard: wording per mode', () => {
  it('selected undefined: the description keeps the switch wording and the accept button says turn on', async () => {
    const user = userEvent.setup();
    renderCard(props());
    expect(screen.getByText(COPILOT_PROVIDER_COPY.description)).toBeInTheDocument();
    expect(screen.getByText(/Opt-in; off until you turn it on\./)).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: 'Enable GitHub Copilot' }));
    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(within(dialog).getByRole('button', { name: 'Agree and turn on' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Agree and use GitHub Copilot' })).not.toBeInTheDocument();
  });

  it.each([true, false])('selected %s: the description drops the switch wording', (selected) => {
    renderCard(props({ selected, onDecline: vi.fn() }));
    expect(screen.getByText(COPILOT_PROVIDER_COPY.selectedDescription)).toBeInTheDocument();
    expect(screen.queryByText(/Opt-in; off until you turn it on/)).not.toBeInTheDocument();
  });

  it('selected true: the accept button says use GitHub Copilot, over the same consent points', async () => {
    renderCard(props({ selected: true, onDecline: vi.fn() }));
    const dialog = await screen.findByRole('dialog', { name: COPILOT_CONSENT_COPY.title });
    expect(within(dialog).getByRole('button', { name: 'Agree and use GitHub Copilot' })).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Agree and turn on' })).not.toBeInTheDocument();
    for (const point of COPILOT_CONSENT_COPY.points) {
      expect(within(dialog).getByText(point.heading)).toBeInTheDocument();
      expect(within(dialog).getByText(point.text)).toBeInTheDocument();
    }
    // Accepting saves the unchanged consent version (pinned in 'selected true: Accept calls onUpdate').
    expect(COPILOT_CONSENT_VERSION).toBe('2');
  });
});

describe('CopilotProviderCard: the model shown', () => {
  const modelBox = () => screen.getByRole('combobox', { name: /Model/ });

  it.each([
    ['switch', {}],
    ['selected', { selected: true }],
  ] as const)('%s mode: no saved model shows the first offered model', (_mode, extra) => {
    renderCard(props({ ...extra, settings: consentedSettings({ model: null }), status: makeStatus({ ...SIGNED_IN }) }));
    expect(modelBox()).toHaveTextContent('GPT-5');
  });

  it.each([
    ['switch', {}],
    ['selected', { selected: true }],
  ] as const)('%s mode: a saved model that is no longer offered shows the first offered model', (_mode, extra) => {
    renderCard(
      props({ ...extra, settings: consentedSettings({ model: 'retired-model' }), status: makeStatus({ ...SIGNED_IN }) }),
    );
    expect(modelBox()).toHaveTextContent('GPT-5');
  });

  it.each([
    ['switch', {}],
    ['selected', { selected: true }],
  ] as const)('%s mode: a saved model that is offered is shown', (_mode, extra) => {
    renderCard(
      props({ ...extra, settings: consentedSettings({ model: 'claude-sonnet' }), status: makeStatus({ ...SIGNED_IN }) }),
    );
    expect(modelBox()).toHaveTextContent('Claude Sonnet');
  });

  it('picking another model from the effective default calls onUpdate({ model })', async () => {
    const user = userEvent.setup();
    const p = props({ selected: true, settings: consentedSettings({ model: null }), status: makeStatus({ ...SIGNED_IN }) });
    renderCard(p);
    await user.click(modelBox());
    await user.click(await screen.findByRole('option', { name: 'Claude Sonnet' }));
    await waitFor(() => expect(p.onUpdate).toHaveBeenCalledWith({ model: 'claude-sonnet' }));
  });
});

describe('CopilotProviderCard: device code expiry', () => {
  it('stops waiting when the code expires and offers a new code', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const expiring: CopilotSignInChallenge = {
      ...DEVICE,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    let signal: AbortSignal | undefined;
    const onSignIn = vi
      .fn()
      .mockResolvedValueOnce(expiring)
      .mockResolvedValueOnce({ ...DEVICE, userCode: 'WXYZ-9999' });
    const p = props({
      settings: consentedSettings(),
      onSignIn,
      onWaitForSignIn: vi.fn(
        (s: AbortSignal) =>
          new Promise<void>((_resolve, reject) => {
            signal = s;
            s.addEventListener('abort', () => reject(new Error('sign_in_cancelled')));
          }),
      ),
    });
    renderCard(p);

    fireEvent.click(screen.getByRole('button', { name: 'Sign in with GitHub Copilot' }));
    await screen.findByText('ABCD-1234');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(await screen.findByText(/This code has expired/)).toBeInTheDocument();
    expect(signal?.aborted).toBe(true);
    expect(screen.queryByText('ABCD-1234')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Get a new code' }));
    expect(await screen.findByText('WXYZ-9999')).toBeInTheDocument();
    expect(onSignIn).toHaveBeenCalledTimes(2);
  });
});

describe('CopilotProviderCard: sign-out', () => {
  it('calls onSignOut', async () => {
    const user = userEvent.setup();
    const p = props({ settings: consentedSettings(), status: makeStatus({ ...SIGNED_IN }) });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(p.onSignOut).toHaveBeenCalledTimes(1));
  });

  it('shows a readable error when sign-out fails', async () => {
    const user = userEvent.setup();
    const p = props({
      settings: consentedSettings(),
      status: makeStatus({ ...SIGNED_IN }),
      onSignOut: vi.fn().mockRejectedValue(new Error('Could not reach the runtime.')),
    });
    renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByText('Could not reach the runtime.')).toBeInTheDocument();
  });
});

describe('CopilotProviderCard: capabilities', () => {
  it('lists Notes, Knowledge extraction, Name check and Ask as available by default', () => {
    renderCard(props({ settings: consentedSettings(), status: makeStatus({ ...SIGNED_IN }) }));
    const list = screen.getByRole('list', { name: 'GitHub Copilot capabilities' });
    const rows = within(list).getAllByRole('listitem');
    const text = (label: string) => rows.find((r) => within(r).queryByText(label))!;

    for (const label of ['Notes', 'Knowledge extraction', 'Name check', 'Ask']) {
      expect(within(text(label)).getByText('Available')).toBeInTheDocument();
    }
  });

  it('lists Ask as unavailable with the provider-neutral reason when the status reports it (a tool-less model)', () => {
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ ...SIGNED_IN, unavailableTasks: [{ task: 'ask.respond', reason: 'needs_tool_calling' }] }),
      }),
    );
    const list = screen.getByRole('list', { name: 'GitHub Copilot capabilities' });
    const rows = within(list).getAllByRole('listitem');
    const text = (label: string) => rows.find((r) => within(r).queryByText(label))!;

    for (const label of ['Notes', 'Knowledge extraction', 'Name check']) {
      expect(within(text(label)).getByText('Available')).toBeInTheDocument();
    }
    const ask = text('Ask');
    expect(within(ask).getByText('Not available')).toBeInTheDocument();
    expect(within(ask).getByText('Needs a model with tool calling.')).toBeInTheDocument();
    expect(within(ask).queryByText(/OpenAI/)).not.toBeInTheDocument();
  });

  it('shows Ask as available when unavailableTasks has no ask.respond', () => {
    renderCard(
      props({ settings: consentedSettings(), status: makeStatus({ ...SIGNED_IN, unavailableTasks: [] }) }),
    );
    const row = screen.getByText('Ask').closest('li')!;
    expect(within(row).getByText('Available')).toBeInTheDocument();
  });

  it('adds a Search by meaning row only when embeddings are unavailable', () => {
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({
          ...SIGNED_IN,
          unavailableTasks: [
            { task: 'ask.respond', reason: 'needs_tool_calling' },
            { task: 'search.embed', reason: 'needs_embeddings' },
          ],
        }),
      }),
    );
    const row = screen.getByText('Search by meaning').closest('li')!;
    expect(within(row).getByText('Not available')).toBeInTheDocument();
  });
});

describe('CopilotProviderCard: runtime', () => {
  it('missing: states the size and downloads on request', async () => {
    const user = userEvent.setup();
    const onDownloadRuntime = vi.fn().mockResolvedValue(undefined);
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
        onDownloadRuntime,
      }),
    );
    expect(screen.getByText(/Download it once \(about 130 to 175 MB\)/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Download runtime' }));
    expect(onDownloadRuntime).toHaveBeenCalledTimes(1);
  });

  it('missing without a download handler shows the notice but no button', () => {
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
      }),
    );
    expect(screen.getByText(/The Copilot runtime is not installed/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Download runtime' })).not.toBeInTheDocument();
  });

  it('downloading: renders the progress and a Cancel button', async () => {
    const user = userEvent.setup();
    const onCancelRuntimeDownload = vi.fn();
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'downloading', version: null, progress: 0.42 } }),
        onCancelRuntimeDownload,
      }),
    );
    expect(screen.getByText('Downloading the Copilot runtime… 42%')).toBeInTheDocument();
    const bar = screen.getByRole('progressbar', { name: 'Copilot runtime download' });
    expect(bar).toHaveAttribute('aria-valuenow', '42');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelRuntimeDownload).toHaveBeenCalledTimes(1);
  });

  it('downloading: Cancel stays enabled while the download call is still pending', async () => {
    const user = userEvent.setup();
    const onCancelRuntimeDownload = vi.fn();
    // A port that resolves only when the download has finished.
    const onDownloadRuntime = vi.fn(() => new Promise<void>(() => undefined));
    const p = props({
      settings: consentedSettings(),
      status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
      onDownloadRuntime,
      onCancelRuntimeDownload,
    });
    const { rerenderCard } = renderCard(p);
    await user.click(screen.getByRole('button', { name: 'Download runtime' }));
    expect(onDownloadRuntime).toHaveBeenCalledTimes(1);
    rerenderCard({ ...p, status: makeStatus({ runtime: { state: 'downloading', version: null, progress: 0.3 } }) });

    const cancel = screen.getByRole('button', { name: 'Cancel' });
    expect(cancel).toBeEnabled();
    await user.click(cancel);
    expect(onCancelRuntimeDownload).toHaveBeenCalledTimes(1);
  });

  it('missing: the Download button is disabled while the download call is pending', async () => {
    const user = userEvent.setup();
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'missing', version: null, progress: null } }),
        onDownloadRuntime: vi.fn(() => new Promise<void>(() => undefined)),
      }),
    );
    await user.click(screen.getByRole('button', { name: 'Download runtime' }));
    expect(screen.getByRole('button', { name: 'Download runtime' })).toBeDisabled();
  });

  it('downloading with unknown progress shows an indeterminate bar', () => {
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'downloading', version: null, progress: null } }),
      }),
    );
    expect(screen.getByText('Downloading the Copilot runtime…')).toBeInTheDocument();
    expect(screen.getByRole('progressbar', { name: 'Copilot runtime download' })).not.toHaveAttribute('aria-valuenow');
  });

  it('error: renders readable text and a retry; a failed download is worded', async () => {
    const user = userEvent.setup();
    const onDownloadRuntime = vi.fn().mockRejectedValue(new Error('Checksum did not match.'));
    renderCard(
      props({
        settings: consentedSettings(),
        status: makeStatus({ runtime: { state: 'error', version: null, progress: null } }),
        onDownloadRuntime,
      }),
    );
    expect(screen.getByText(/could not be installed or started/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try download again' }));
    expect(await screen.findByText('Checksum did not match.')).toBeInTheDocument();
  });

  it('ready: shows no runtime notice', () => {
    renderCard(props({ settings: consentedSettings() }));
    expect(screen.queryByText(/Copilot runtime/)).not.toBeInTheDocument();
  });
});

describe('CopilotProviderCard: footer and accessibility', () => {
  it('lists the allowed hosts', () => {
    renderCard(
      props({ settings: consentedSettings(), allowedHosts: ['api.githubcopilot.com', 'github.com'] }),
    );
    expect(
      screen.getByText('Besides this device, KVox may connect only to api.githubcopilot.com, github.com.'),
    ).toBeInTheDocument();
  });

  it.each(['light', 'dark'] as const)('has no axe violations in %s mode, off and signed in', async (mode) => {
    const off = renderCard(props(), mode);
    expect(await axe(off.container, AXE_OPTIONS)).toHaveNoViolations();
    off.unmount();

    const on = renderCard(
      props({ settings: consentedSettings({ model: 'gpt-5' }), status: makeStatus({ ...SIGNED_IN }) }),
      mode,
    );
    expect(await axe(on.container, AXE_OPTIONS)).toHaveNoViolations();
  });

  it('uses no hard-coded colours', async () => {
    const files = ['CopilotProviderCard', 'CopilotConsentBody', 'CopilotSignInDialog', 'CopilotRuntimeSection'].map(
      (n) => readFileSync(join(import.meta.dirname, '../../src/copilot/ui', `${n}.tsx`), 'utf8'),
    );
    for (const source of files) {
      expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(source).not.toMatch(/\brgba?\(/);
    }
  });
});
