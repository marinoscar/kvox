import { useState } from 'react';
import { vi } from 'vitest';
import type { Dispatch, SetStateAction } from 'react';

/**
 * Test double for `virtual:pwa-register/react` (issue #219, epic #215).
 *
 * THAT MODULE DOES NOT EXIST ON DISK. It is synthesised by `VitePWA()` during
 * a real build, and `vitest.config.ts` does not (and should not) run that
 * plugin — doing so would make every unit test depend on a Workbox build. So
 * without a stand-in, importing `components/pwa/UpdatePrompt.tsx` fails to
 * resolve, which takes `App.test.tsx` down with it.
 *
 * This file is wired in as a `resolve.alias` in `vitest.config.ts` rather than
 * through `vi.mock()` in each suite, for two reasons:
 *
 *   1. `vi.mock()` cannot mock a specifier that does not resolve at all — the
 *      alias is what makes the id resolvable in the first place.
 *   2. Every suite that renders `<App />` transitively imports the virtual
 *      module, so the alternative is repeating an identical `vi.mock` factory
 *      in each of them and watching them drift.
 *
 * `useRegisterSW` here is a REAL HOOK over real `useState`, not a function
 * returning frozen values: the shape it returns (`[value, setValue]` tuples)
 * is one the component writes back to when the user dismisses a prompt, and a
 * double whose setters do nothing would make dismissal untestable and hide the
 * most likely wiring bug.
 */

interface RegisterSWState {
  needRefresh: boolean;
  offlineReady: boolean;
}

const DEFAULTS: RegisterSWState = { needRefresh: false, offlineReady: false };

/**
 * The state `useRegisterSW` is seeded with on its next mount. Set it BEFORE
 * `render()`; the hook reads it as an initial value, exactly as the real one
 * arrives at its state from the registration lifecycle rather than from a prop.
 */
let initialState: RegisterSWState = { ...DEFAULTS };

/** The real hook's `updateServiceWorker`, which posts `SKIP_WAITING` and reloads. */
export const updateServiceWorkerMock = vi.fn<(reloadPage?: boolean) => Promise<void>>(
  () => Promise.resolve(),
);

export function useRegisterSW(): {
  needRefresh: [boolean, Dispatch<SetStateAction<boolean>>];
  offlineReady: [boolean, Dispatch<SetStateAction<boolean>>];
  updateServiceWorker: (reloadPage?: boolean) => Promise<void>;
} {
  const needRefresh = useState(initialState.needRefresh);
  const offlineReady = useState(initialState.offlineReady);

  return { needRefresh, offlineReady, updateServiceWorker: updateServiceWorkerMock };
}

/** Seeds the state the next mounted `useRegisterSW` will report. */
export function setRegisterSWState(next: Partial<RegisterSWState>): void {
  initialState = { ...initialState, ...next };
}

/** Restores the default (no update waiting, not freshly cached) and clears calls. */
export function resetRegisterSWMock(): void {
  initialState = { ...DEFAULTS };
  updateServiceWorkerMock.mockClear();
}
