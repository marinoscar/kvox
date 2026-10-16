/**
 * `NavigationFeaturesProvider` / `useNavigationFeatures` — issue #438.
 *
 * `useAiTasksConfig` is mocked rather than exercised over MSW: this provider is a
 * thin derivation over that hook's own `config`/`refresh` (see the file
 * header's "ONE read per shell" comment), and the hook's own network
 * behaviour — retries, error mapping, `isMounted` — is `useAiTasksConfig`'s own
 * test's job, not this one's. What this file has to pin is the DERIVATION:
 * `graph` reads `false` while unanswered (loading, erroring, or never asked at
 * all — outside a provider), and `true` only once `graphEnabled === true` has
 * actually landed; and that `refresh` is exactly the hook's own fetcher, not a
 * fresh no-op wrapping it.
 */

import { describe, it, expect, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { render } from '../utils/test-utils';
import {
  NavigationFeaturesProvider,
  useNavigationFeatures,
} from '../../contexts/NavigationFeaturesContext';

vi.mock('../../hooks/useAiTasksConfig', () => ({
  useAiTasksConfig: vi.fn(),
}));

import { useAiTasksConfig } from '../../hooks/useAiTasksConfig';
import type { UseAiTasksConfigReturn } from '../../hooks/useAiTasksConfig';

const mockUseAiTasksConfig = vi.mocked(useAiTasksConfig);

/** Only the fields `NavigationFeaturesProvider` actually reads. */
function aiConfigReturn(
  overrides: Partial<UseAiTasksConfigReturn> = {},
): UseAiTasksConfigReturn {
  return {
    config: null,
    isLoading: false,
    loadError: null,
    keyConfigured: false,
    available: false,
    canGenerate: false,
    refresh: vi.fn(),
    ...overrides,
  };
}

/** Renders the provider's value as text, and exposes `refresh` for a click. */
function Probe() {
  const { features, refresh } = useNavigationFeatures();
  return (
    <div>
      <div data-testid="graph">{String(features.graph)}</div>
      <button onClick={() => void refresh()}>refresh</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <NavigationFeaturesProvider>
      <Probe />
    </NavigationFeaturesProvider>,
  );
}

describe('NavigationFeaturesProvider', () => {
  it('reads graph as false while the config is still loading', () => {
    mockUseAiTasksConfig.mockReturnValue(aiConfigReturn({ isLoading: true, config: null }));

    renderProbe();

    expect(screen.getByTestId('graph')).toHaveTextContent('false');
  });

  it('reads graph as false once loaded when graphEnabled is false', () => {
    mockUseAiTasksConfig.mockReturnValue(
      aiConfigReturn({
        config: {
          available: true,
          provider: 'openai',
          providerLabel: 'OpenAI',
          models: [],
          defaultModel: null,
          maxInputTokens: null,
          maxOutputTokens: null,
          keyConfigured: true,
          graphEnabled: false,
        },
      }),
    );

    renderProbe();

    expect(screen.getByTestId('graph')).toHaveTextContent('false');
  });

  it('reads graph as false when the config load errored', () => {
    // A failed load leaves `config: null` (see `useAiTasksConfig`'s own catch
    // branch) — the case this provider's header calls "UNKNOWN IS OFF".
    mockUseAiTasksConfig.mockReturnValue(
      aiConfigReturn({ config: null, loadError: 'Failed to load AI configuration' }),
    );

    renderProbe();

    expect(screen.getByTestId('graph')).toHaveTextContent('false');
  });

  it('reads graph as true once graphEnabled lands true', () => {
    mockUseAiTasksConfig.mockReturnValue(
      aiConfigReturn({
        config: {
          available: true,
          provider: 'openai',
          providerLabel: 'OpenAI',
          models: [],
          defaultModel: null,
          maxInputTokens: null,
          maxOutputTokens: null,
          keyConfigured: true,
          graphEnabled: true,
        },
      }),
    );

    renderProbe();

    expect(screen.getByTestId('graph')).toHaveTextContent('true');
  });

  it('exposes the hook’s own refresh function, not a fresh wrapper', async () => {
    const refresh = vi.fn().mockResolvedValue(undefined);
    mockUseAiTasksConfig.mockReturnValue(aiConfigReturn({ refresh }));

    const user = userEvent.setup();
    renderProbe();

    await user.click(screen.getByRole('button', { name: 'refresh' }));

    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe('useNavigationFeatures outside a provider', () => {
  it('defaults to graph false and a no-op refresh', async () => {
    // No mocked `useAiTasksConfig` return matters here — there is no provider to
    // call the hook at all, which is the point: every consumer must survive a
    // shell mount that has not wrapped it (`Layout` mounting order, a stray
    // test render).
    render(<Probe />);

    expect(screen.getByTestId('graph')).toHaveTextContent('false');

    const user = userEvent.setup();
    // Must not throw — the default value's `refresh` is a real, callable noop.
    await user.click(screen.getByRole('button', { name: 'refresh' }));
  });
});
