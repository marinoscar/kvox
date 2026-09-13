import '@testing-library/jest-dom';
import { cleanup } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { server } from './mocks/server';

// Set base URL for fetch
const BASE_URL = 'http://localhost:3000';
if (typeof global !== 'undefined') {
  (global as any).BASE_URL = BASE_URL;
}

// Mock location for testing
Object.defineProperty(window, 'location', {
  writable: true,
  value: {
    href: BASE_URL,
    origin: BASE_URL,
    protocol: 'http:',
    host: 'localhost:3000',
    hostname: 'localhost',
    port: '3000',
    pathname: '/',
    search: '',
    hash: '',
    reload: vi.fn(),
    assign: vi.fn(),
    replace: vi.fn(),
  },
});

// ---------------------------------------------------------------------------
// window.matchMedia mock (query-aware)
//
// The naive "always false" mock this replaced was fine while nothing in the
// app branched on a media query for layout. It stops being fine once
// responsive chrome (nav rail breakpoints, DataTable's viewport fallback)
// starts gating on `theme.breakpoints.up()/down()`. This mock parses
// `min-width`/`max-width` conditions against a module-level viewport width
// and answers them for real; anything else (e.g. `prefers-color-scheme`)
// still answers `false`, which is what ThemeContext's system-preference
// check wants by default.
//
// Verified against a real `createTheme()` (apps/web, @mui/material 9.1.0):
//   theme.breakpoints.up('sm')   -> "@media (min-width:600px)"
//   theme.breakpoints.up('lg')   -> "@media (min-width:1200px)"
//   theme.breakpoints.down('sm') -> "@media (max-width:599.95px)"
//   theme.breakpoints.down('lg') -> "@media (max-width:1199.95px)"
// Note the *no space* after the colon and the *fractional* down() value.
// MUI's useMediaQuery strips the leading "@media" before calling
// matchMedia (see @mui/system/useMediaQuery/useMediaQuery.js:
// `query.replace(/^@media( ?)/m, '')`), so the mock only ever sees
// `(min-width:600px)` in practice. We still defensively strip a leading
// "@media" ourselves in case something calls window.matchMedia directly
// with the raw breakpoints string.
// ---------------------------------------------------------------------------

const DEFAULT_VIEWPORT_WIDTH = 1440;
let viewportWidth = DEFAULT_VIEWPORT_WIDTH;

type ChangeListener = () => void;

interface MockMediaQueryListEntry {
  media: string;
  matches: boolean;
  listeners: Set<ChangeListener>;
  recompute: () => void;
}

// Every MediaQueryList mock ever handed out, so setViewportWidth() can
// recompute and notify each one. Cleared every test in the global afterEach
// below so no test leaks listeners into the next.
const mediaQueryListRegistry = new Set<MockMediaQueryListEntry>();

/**
 * Parses `(min-width: Npx)` / `(max-width: Npx)` conditions (optionally
 * joined with "and", as MUI's `only()`/`between()` emit) out of a media
 * query string and evaluates them against `width`. Handles both the
 * no-space MUI form (`min-width:600px`) and a spaced, hand-written form
 * (`min-width: 600px`), plus fractional values (`599.95px`).
 *
 * Returns `false` for any query with no recognized min-width/max-width
 * condition (e.g. `prefers-color-scheme: dark`), which keeps ThemeContext's
 * system-preference check answering `false` as before.
 */
function evaluateMediaQuery(query: string, width: number): boolean {
  const normalized = query.replace(/^@media\s*/, '').trim();

  const minWidths = [...normalized.matchAll(/\(min-width:\s*([\d.]+)px\)/g)].map((m) =>
    parseFloat(m[1]),
  );
  const maxWidths = [...normalized.matchAll(/\(max-width:\s*([\d.]+)px\)/g)].map((m) =>
    parseFloat(m[1]),
  );

  if (minWidths.length === 0 && maxWidths.length === 0) {
    return false;
  }

  const minSatisfied = minWidths.every((min) => width >= min);
  const maxSatisfied = maxWidths.every((max) => width <= max);
  return minSatisfied && maxSatisfied;
}

/**
 * Live-update mechanism: each mock MediaQueryList keeps its own `matches`
 * plus a `change` listener set (mirrors the real MediaQueryList/
 * addEventListener surface). setViewportWidth() recomputes every registered
 * entry and, on a flip, invokes its listeners synchronously.
 *
 * This matters because MUI's useMediaQuery (React 18/19 path) subscribes via
 * `mediaQueryList.addEventListener('change', notify)` through
 * useSyncExternalStore — `notify` IS the store-update callback, so firing it
 * is what makes useSyncExternalStore re-pull `matches` and re-render.
 * Wrap calls to setViewportWidth() in `act()` (or an RTL helper that already
 * does, like `fireEvent`/`await screen.find*`) so React flushes that
 * re-render within the test.
 */
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => {
    const entry: MockMediaQueryListEntry = {
      media: query,
      matches: evaluateMediaQuery(query, viewportWidth),
      listeners: new Set<ChangeListener>(),
      recompute: () => {},
    };
    entry.recompute = () => {
      const next = evaluateMediaQuery(query, viewportWidth);
      if (next !== entry.matches) {
        entry.matches = next;
        entry.listeners.forEach((listener) => listener());
      }
    };
    mediaQueryListRegistry.add(entry);

    return {
      get matches() {
        return entry.matches;
      },
      media: query,
      onchange: null,
      addListener: vi.fn((listener: ChangeListener) => entry.listeners.add(listener)),
      removeListener: vi.fn((listener: ChangeListener) => entry.listeners.delete(listener)),
      addEventListener: vi.fn((type: string, listener: ChangeListener) => {
        if (type === 'change') entry.listeners.add(listener);
      }),
      removeEventListener: vi.fn((type: string, listener: ChangeListener) => {
        if (type === 'change') entry.listeners.delete(listener);
      }),
      dispatchEvent: vi.fn(),
    };
  }),
});

/** Drives the mocked viewport width used by matchMedia's min-width/max-width evaluation. */
export function setViewportWidth(px: number): void {
  viewportWidth = px;
  mediaQueryListRegistry.forEach((entry) => entry.recompute());
}

/** Restores the default (desktop, 1440px) viewport width. */
export function resetViewportWidth(): void {
  setViewportWidth(DEFAULT_VIEWPORT_WIDTH);
}

// ---------------------------------------------------------------------------
// Notification / navigator.permissions / navigator.serviceWorker mocks
// (issue #232, epic #215)
//
// Every notification test file used to hand-roll its own fake `Notification`
// and `navigator.serviceWorker`, capture whatever jsdom had before it (almost
// always `undefined` - jsdom implements neither API), and restore that in its
// own `afterEach`. That idiom still works and is deliberately left in place
// below - a test asserting a SPECIFIC state (a rejecting `getRegistration()`,
// a constructor that throws, `permission: 'denied'`) still reaches for it
// directly, exactly as before, by reassigning the properties this block
// installs (all three are `configurable: true, writable: true`, so a plain
// `(window as any).Notification = ...` or
// `Object.defineProperty(window.navigator, 'serviceWorker', {...})` keeps
// working unchanged).
//
// What this adds is a NEUTRAL BASELINE so a test that does not care about
// these APIs is not left with jsdom's bare "not implemented at all" shape,
// and so per-file capture/restore boilerplate whose only job was recreating
// that baseline is no longer needed. Mirrors matchMedia's approach above:
// installed as plain objects/functions (not a stateful registry, since
// nothing here needs live cross-instance notification the way viewport width
// does), and reinstalled FRESH before every test in the `beforeEach` below so
// a test's mutation (or deletion) of any of the three never leaks into the
// next one - the equivalent of matchMedia's own `resetViewportWidth()` call
// in `afterEach`, just run on the other side of the test for the same
// isolation guarantee (beforeEach hooks run outer-to-inner, so this global
// one always finishes before a test file's own `beforeEach` starts).
//
// Defaults, chosen to be the least eventful thing each API can report:
//   - `Notification.permission` is `'default'` (not yet asked), and
//     `requestPermission()` resolves `'default'` without prompting anything.
//   - `navigator.permissions.query()` REJECTS, matching real Safari for an
//     unsupported permission name - every current caller already treats that
//     as "fall back to visibilitychange" via a `.catch(() => {})`, so this
//     produces no extra async state update for a test that never awaits one.
//   - `navigator.serviceWorker.getRegistration()` resolves `undefined` (no
//     worker registered yet - the real shape of "not installed"), `.ready`
//     resolves a registration (nothing in this codebase reads `.ready` today,
//     but the mock is provided for completeness), and the registration's
//     `showNotification`/`getNotifications` are harmless resolving spies.
// ---------------------------------------------------------------------------

function createDefaultNotificationMock() {
  const ctor = vi.fn(function (
    this: { onclick: (() => void) | null; close: () => void },
    _title: string,
    _options?: unknown,
  ) {
    this.onclick = null;
    this.close = vi.fn();
  });
  Object.assign(ctor, {
    permission: 'default' as NotificationPermission,
    requestPermission: vi.fn().mockResolvedValue('default' as NotificationPermission),
  });
  return ctor;
}

function createDefaultServiceWorkerRegistrationMock() {
  return {
    showNotification: vi.fn().mockResolvedValue(undefined),
    getNotifications: vi.fn().mockResolvedValue([]),
  };
}

function createDefaultServiceWorkerMock() {
  return {
    controller: null,
    getRegistration: vi.fn().mockResolvedValue(undefined),
    ready: Promise.resolve(createDefaultServiceWorkerRegistrationMock()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
}

function createDefaultPermissionsMock() {
  return {
    query: vi.fn().mockRejectedValue(new Error('permission name not supported')),
  };
}

function installNotificationMocks(): void {
  Object.defineProperty(window, 'Notification', {
    configurable: true,
    writable: true,
    value: createDefaultNotificationMock(),
  });
  Object.defineProperty(window.navigator, 'permissions', {
    configurable: true,
    writable: true,
    value: createDefaultPermissionsMock(),
  });
  Object.defineProperty(window.navigator, 'serviceWorker', {
    configurable: true,
    writable: true,
    value: createDefaultServiceWorkerMock(),
  });
}

// Mock window.scrollTo
Object.defineProperty(window, 'scrollTo', {
  writable: true,
  value: vi.fn(),
});

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};

  return {
    getItem: (key: string) => store[key] || null,
    setItem: (key: string, value: string) => {
      store[key] = value.toString();
    },
    removeItem: (key: string) => {
      delete store[key];
    },
    clear: () => {
      store = {};
    },
  };
})();

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
});

// Mock ResizeObserver as a class
class ResizeObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}
global.ResizeObserver = ResizeObserverMock;

// Mock IntersectionObserver as a class
class IntersectionObserverMock {
  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
  root = null;
  rootMargin = '';
  thresholds = [];
}
global.IntersectionObserver = IntersectionObserverMock as any;

// Setup MSW server
beforeAll(() => {
  server.listen({
    onUnhandledRequest: 'warn' // Changed from 'error' to 'warn' for debugging
  });
});

beforeEach(() => {
  installNotificationMocks();
});

afterEach(() => {
  cleanup();
  server.resetHandlers();
  resetViewportWidth();
  mediaQueryListRegistry.clear();
});

afterAll(() => {
  server.close();
});
