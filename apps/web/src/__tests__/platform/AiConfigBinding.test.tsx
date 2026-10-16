/**
 * `AppAiConfigProvider` — this app's mount of the platform AI config (issue
 * #477, epic #472).
 *
 * Same cases as the telemetry binding it mirrors: nothing is fetched before a
 * session exists (the provider sits above the login page, where
 * `GET /api/ai/config` would answer 401), the first answer is reported as
 * LOADING rather than as "off" (so a deep link to an AI route is not bounced by
 * `RequireAiEnabled` in the gap), and sign-out answers "off" again.
 */

import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useContext } from 'react';
import { AiConfigContext, useAiFeatures } from '@marinoscar/platform-web/ai/headless';

import { render, mockUser } from '../utils/test-utils';
import { server } from '../mocks/server';
import { AppAiConfigProvider } from '../../platform/AiConfigBinding';

function Probe() {
  const shared = useContext(AiConfigContext);
  const config = shared?.config ?? { enabled: false };
  const isLoading = shared?.isLoading ?? false;
  const { ai } = useAiFeatures();
  return (
    <div>
      <div data-testid="enabled">{String(config.enabled)}</div>
      <div data-testid="loading">{String(isLoading)}</div>
      <div data-testid="feature">{String(ai)}</div>
    </div>
  );
}

function serve(enabled: boolean) {
  const calls = { count: 0 };
  server.use(
    http.get('*/api/ai/config', () => {
      calls.count += 1;
      return HttpResponse.json({ data: { enabled, keyPolicy: 'byok', providers: [] } });
    }),
  );
  return calls;
}

const mount = (authenticated: boolean) =>
  render(
    <AppAiConfigProvider>
      <Probe />
    </AppAiConfigProvider>,
    { wrapperOptions: { authenticated, user: authenticated ? mockUser : null } },
  );

describe('AppAiConfigProvider', () => {
  it('reports loading, then the answer, once the session is authenticated', async () => {
    serve(true);
    mount(true);

    // The first paint of an authenticated session is "loading", never "off".
    expect(screen.getByTestId('loading')).toHaveTextContent('true');

    await waitFor(() => expect(screen.getByTestId('enabled')).toHaveTextContent('true'));
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('feature')).toHaveTextContent('true');
  });

  it('answers off when the deployment has AI switched off', async () => {
    serve(false);
    mount(true);

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('feature')).toHaveTextContent('false');
  });

  it('does not fetch without a session, and answers off and settled', async () => {
    const calls = serve(true);
    mount(false);

    expect(screen.getByTestId('enabled')).toHaveTextContent('false');
    expect(screen.getByTestId('loading')).toHaveTextContent('false');
    expect(screen.getByTestId('feature')).toHaveTextContent('false');
    // Give a stray effect a chance to fire.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(calls.count).toBe(0);
  });

  it('fails closed when the answer cannot be read', async () => {
    server.use(
      http.get('*/api/ai/config', () => HttpResponse.json({ message: 'Down' }, { status: 500 })),
    );
    mount(true);

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'));
    expect(screen.getByTestId('enabled')).toHaveTextContent('false');
  });
});
