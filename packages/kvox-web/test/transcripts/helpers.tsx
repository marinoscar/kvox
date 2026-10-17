/**
 * Shared test kit of the transcripts slice: the globals the pages need from
 * jsdom, a viewer fixture, and a `render` that mounts a page the way a host
 * does (`KvoxWebHostProvider` + theme + router) over the fake host.
 *
 * Import it from any test that renders a component or a hook that reads the
 * host; the module-level installs below run once per test file.
 */

import { configure, renderHook as renderHookBare } from '@testing-library/react';
import type { RenderHookOptions, RenderHookResult, RenderResult } from '@testing-library/react';
import type { ReactElement, ReactNode } from 'react';
import { beforeEach, vi } from 'vitest';

import { KvoxWebHostProvider, clearFeedCache } from '../../src/core/headless/index.js';
import { createFakeKvoxWebHost, renderWithKvoxHost } from '../../src/core/testing/index.js';
import type { FakeKvoxWebHost, FakeKvoxWebHostOptions } from '../../src/core/testing/index.js';
import type { TranscriptAiAccess, TranscriptSharingAdapter } from '../../src/transcripts/ui/slots.js';

/**
 * Testing Library's own async timeout, raised from its 1s default.
 *
 * `findBy*`/`waitFor` run on a budget separate from the test timeout, and 1s of
 * it is spent competing with every other worker for the CPU. The transcript
 * suites mount a virtualized list over a full fixture and are the first to lose
 * that race. This weakens no assertion: a `findBy*` whose element never appears
 * still fails.
 */
configure({ asyncUtilTimeout: 5_000 });

class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;

class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  root = null;
  rootMargin = '';
  thresholds = [];
}
globalThis.IntersectionObserver = IntersectionObserverMock as unknown as typeof IntersectionObserver;

Object.defineProperty(window, 'scrollTo', { writable: true, configurable: true, value: vi.fn() });

beforeEach(() => {
  clearFeedCache();
});

/** A viewer fixture: who the host says is signed in. */
export interface MockUser {
  id: string;
  email: string;
  permissions: string[];
}

/** An ordinary account: no transcript or note permission at all. */
export const mockUser: MockUser = {
  id: 'test-user-id',
  email: 'test@example.com',
  permissions: ['user_settings:read', 'user_settings:write'],
};

/**
 * A user holding what the seeded `admin` role grants that these pages read.
 * `transcripts:*` and `notes:*` are seeded to ALL THREE roles, so a fixture
 * without them would be a user that cannot exist.
 */
export const mockAdminUser: MockUser = {
  id: 'admin-user-id',
  email: 'admin@example.com',
  permissions: [
    'user_settings:read',
    'user_settings:write',
    'system_settings:read',
    'system_settings:write',
    'transcripts:read',
    'transcripts:write',
    'notes:read',
    'notes:write',
    'note_templates:read',
    'note_templates:write',
    'storage:read',
    'storage:write',
  ],
};

/** Options of {@link render}. */
export interface RenderOptions {
  /** Who is signed in and where the router starts. */
  wrapperOptions?: { user?: MockUser | null; route?: string };
  /** Use this host instead of building one. */
  host?: FakeKvoxWebHost;
  /** Options of the fake host when `host` is not given (`routes`, `features`, ...). */
  hostOptions?: FakeKvoxWebHostOptions;
}

/**
 * Renders `ui` inside the fake host, an MUI theme and a `MemoryRouter`.
 *
 * @param ui - The element under test.
 * @param options - The viewer, the first route, and the host or its options.
 * @returns Testing Library's result plus the `host` the element read.
 */
export function render(
  ui: ReactElement,
  options: RenderOptions = {},
): RenderResult & { host: FakeKvoxWebHost } {
  const { wrapperOptions = {}, hostOptions } = options;
  const user = wrapperOptions.user === undefined ? mockUser : wrapperOptions.user;
  const host =
    options.host ??
    createFakeKvoxWebHost({
      viewer: user ? { userId: user.id, permissions: user.permissions } : null,
      ...hostOptions,
    });
  const result = renderWithKvoxHost(ui, host, { route: wrapperOptions.route ?? '/' });
  return Object.assign(result, { host });
}

/** Options of {@link renderHook}. */
export interface HostRenderHookOptions<Props> extends Omit<RenderHookOptions<Props>, 'wrapper'> {
  /** The host the hook reads. Default: a fresh fake host. */
  host?: FakeKvoxWebHost;
  /** Options of the fake host when `host` is not given. */
  hostOptions?: FakeKvoxWebHostOptions;
}

/**
 * `renderHook` inside a `KvoxWebHostProvider`, for the hooks that read the host.
 *
 * @param callback - The hook under test.
 * @param options - Testing Library's options, plus the host or its options.
 * @returns Testing Library's result plus the `host` the hook read.
 */
export function renderHook<Result, Props>(
  callback: (props: Props) => Result,
  options: HostRenderHookOptions<Props> = {},
): RenderHookResult<Result, Props> & { host: FakeKvoxWebHost } {
  const { host: given, hostOptions, ...rest } = options;
  const host = given ?? createFakeKvoxWebHost(hostOptions);
  const result = renderHookBare(callback, {
    ...rest,
    wrapper: ({ children }: { children: ReactNode }) => (
      <KvoxWebHostProvider host={host}>{children}</KvoxWebHostProvider>
    ),
  });
  return Object.assign(result, { host });
}

/**
 * The sharing a host would supply, as stand-ins: a dialog that says what it was
 * opened on, and a "leave" that resolves.
 */
export const testSharing: TranscriptSharingAdapter = {
  ShareDialog: ({ open, title }) => (open ? <div role="dialog">{`Share ${title}`}</div> : null),
  leave: () => Promise.resolve(),
};

/** AI access for a viewer with a key on a deployment that permits AI. */
export const testAi: TranscriptAiAccess = {
  useAiState: () => ({ isLoading: false, keyConfigured: true, available: true, canGenerate: true }),
  KeyRequired: () => <p>Add your AI key to use this</p>,
};
