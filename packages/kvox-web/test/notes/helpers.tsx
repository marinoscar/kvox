/**
 * Shared test kit of the notes slice: the same host-mounting `render` and
 * `renderHook` the transcripts suites use (the fake host, an MUI theme and a
 * `MemoryRouter`), plus the stand-in AI access the pages take.
 *
 * Import it from any test that renders a component or a hook that reads the
 * host.
 */

import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';

import { kvoxGet, useKvoxHost } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeKvoxWebHostOptions } from '../../src/core/testing/index.js';

import type { NotesAiAccess, NotesAiState } from '../../src/notes/ui/ai.js';

import {
  render as baseRender,
  renderHook as baseRenderHook,
} from '../transcripts/helpers.js';
import type { HostRenderHookOptions, RenderOptions } from '../transcripts/helpers.js';
import { bindHost, heldRoutes } from './msw-compat.js';

export { mockAdminUser, mockUser } from '../transcripts/helpers.js';
export type { MockUser, RenderOptions } from '../transcripts/helpers.js';

/**
 * `render` over a fake host that answers the handlers registered so far through
 * `server.use` (see `msw-compat.ts`) and every later one.
 */
export function render(ui: ReactElement, options: RenderOptions = {}) {
  const hostOptions = {
    ...options.hostOptions,
    routes: { ...heldRoutes(), ...options.hostOptions?.routes },
  };
  const result = baseRender(ui, { ...options, hostOptions });
  bindHost(result.host);
  return result;
}

/** `renderHook` over a fake host that answers the handlers registered through `server.use`. */
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: HostRenderHookOptions<Props> = {},
) {
  const hostOptions = {
    ...options.hostOptions,
    routes: { ...heldRoutes(), ...options.hostOptions?.routes },
  };
  const result = baseRenderHook(callback, { ...options, hostOptions });
  bindHost(result.host);
  return result;
}

/** The "add your key" state the web edition draws, reduced to its heading and its link. */
function AiKeyRequiredStandIn(): ReactElement {
  return (
    <section>
      <h2>Add your AI key to use this</h2>
      <a href="/settings/ai">Set up your AI key</a>
    </section>
  );
}

/** The models a viewer with AI may pick in the suites. */
export const TEST_MODELS = [
  { id: 'gpt-4o-mini', label: 'GPT-4o mini' },
  { id: 'gpt-4o', label: 'GPT-4o' },
] as const;

/** The AI state of a viewer with a key on a deployment that permits AI. */
export const READY_AI_STATE: NotesAiState = {
  isLoading: false,
  loadError: null,
  keyConfigured: true,
  available: true,
  models: TEST_MODELS,
  defaultModel: 'gpt-4o-mini',
};

/** AI access whose state is `state` (a viewer with a key, by default). */
export function testAi(state: Partial<NotesAiState> = {}): NotesAiAccess {
  const merged: NotesAiState = { ...READY_AI_STATE, ...state };
  return {
    useAiState: () => merged,
    KeyRequired: AiKeyRequiredStandIn,
  };
}

/**
 * A fake host that answers the handlers registered through `server.use` so far
 * and every later one, for the client suites that call a function with a host
 * instead of rendering anything.
 *
 * @param options - The viewer and other host options.
 * @returns The host.
 */
export function makeHost(options: FakeKvoxWebHostOptions = {}): FakeKvoxWebHost {
  const host = createFakeKvoxWebHost({
    ...options,
    routes: { ...heldRoutes(), ...options.routes },
  });
  bindHost(host);
  return host;
}

interface AiConfigAnswer {
  keyConfigured: boolean;
  available: boolean;
  models: { id: string; label: string }[];
  defaultModel: string | null;
}

/**
 * AI access that asks the HOST, as the web edition does: it reads
 * `GET /ai-tasks/config` through the fake host and reports what came back, so a
 * suite drives the AI state with a handler (`server.use(http.get(...))`) the way
 * it drives everything else. An unanswered or failed read leaves the viewer
 * without a key, the safe direction.
 */
export const hostBackedAi: NotesAiAccess = {
  useAiState(): NotesAiState {
    const host = useKvoxHost();
    const [state, setState] = useState<NotesAiState>({
      isLoading: true,
      loadError: null,
      keyConfigured: false,
      available: false,
      models: [],
      defaultModel: null,
    });
    useEffect(() => {
      let cancelled = false;
      kvoxGet<AiConfigAnswer>(host, '/ai-tasks/config')
        .then((config) => {
          if (cancelled) return;
          setState({
            isLoading: false,
            loadError: null,
            keyConfigured: config.keyConfigured,
            available: config.available,
            models: config.models,
            defaultModel: config.defaultModel,
          });
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setState({
            isLoading: false,
            loadError: error instanceof Error ? error.message : 'Failed to load AI configuration',
            keyConfigured: false,
            available: false,
            models: [],
            defaultModel: null,
          });
        });
      return () => {
        cancelled = true;
      };
    }, [host]);
    return state;
  },
  KeyRequired: AiKeyRequiredStandIn,
};
