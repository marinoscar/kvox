/**
 * The onboarding client — issue #276, epic #271.
 *
 * Two calls with no logic in them, so there are exactly two things worth
 * asserting and this file asserts only those:
 *
 *   1. EACH FUNCTION HITS THE ROUTE ITS NAME CLAIMS. The whole authorisation
 *      model of #275 is that the admin answer lives on a different PREFIX, so a
 *      transposed path here would send every Viewer at the admin route and turn
 *      the provider's careful permission gate into decoration.
 *   2. THE `{ data, meta }` ENVELOPE IS UNWRAPPED. `api.get` does it centrally,
 *      and a consumer reading `state.steps` off an un-unwrapped body gets
 *      `undefined` rather than an error — a failure that shows up as an empty
 *      checklist on a deployment with seven things left to do.
 *
 * Since the boundary-validation fix there is a third, and it is the one with a
 * production crash behind it rather than a cosmetic failure:
 *
 *   3. A 200 THAT IS NOT A CHECKLIST REJECTS. These two functions no longer
 *      CAST the body; they narrow it. Everything below `a 200 that is not a
 *      checklist` is about that, and its header explains the crash it pins.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  ADMIN_ONBOARDING_PATH,
  ONBOARDING_PATH,
  getAdminOnboardingState,
  getOnboardingState,
  parseOnboardingState,
} from '../../services/onboarding';
import {
  adminState,
  step,
  userState,
} from '../components/onboarding/onboardingFixtures';

const API_BASE = 'http://localhost:3000/api';

/** Every path this test's calls touched, in order. */
let paths: string[] = [];

server.events.on('request:start', ({ request }) => {
  paths.push(new URL(request.url).pathname);
});

beforeEach(() => {
  paths = [];
  server.use(
    http.get(`${API_BASE}${ONBOARDING_PATH}`, () =>
      HttpResponse.json({ data: userState(), meta: {} }),
    ),
    http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () =>
      HttpResponse.json({ data: adminState(), meta: {} }),
    ),
  );
});

describe('getOnboardingState', () => {
  it('reads GET /api/onboarding and unwraps the envelope', async () => {
    const state = await getOnboardingState();

    expect(paths).toEqual(['/api/onboarding']);
    expect(state.audience).toBe('user');
    // Reached through the envelope, so a regression to returning `{ data }`
    // fails here rather than silently rendering an empty list.
    expect(state.steps.map((s) => s.key)).toEqual([
      'user.first_transcript',
      'user.profile',
    ]);
  });
});

describe('getAdminOnboardingState', () => {
  it('reads GET /api/admin/onboarding — a different prefix, not a query flag', async () => {
    const state = await getAdminOnboardingState();

    // ⚠ The prefix IS the gate (#275). Asserted as a literal rather than
    // against the exported constant alone, so renaming the constant cannot
    // quietly move the route this client talks to.
    expect(paths).toEqual(['/api/admin/onboarding']);
    expect(ADMIN_ONBOARDING_PATH).toBe('/admin/onboarding');
    expect(state.audience).toBe('admin');
  });

  it('propagates a 403 rather than swallowing it into an empty checklist', async () => {
    server.use(
      http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () =>
        HttpResponse.json({ message: 'Forbidden' }, { status: 403 }),
      ),
    );

    // The provider decides what a failure means (render nothing); the client
    // must not decide it here by returning an empty state, which would be
    // indistinguishable from "this deployment has nothing left to set up".
    await expect(getAdminOnboardingState()).rejects.toThrow();
  });
});

// =============================================================================
// A 200 THAT IS NOT A CHECKLIST — the production crash, pinned
// =============================================================================
//
// ⚠ EVERY CASE BELOW IS A `200`. That is what makes them worth a suite: a
// non-2xx already rejects in `ApiService.request` and the provider has handled
// that since #276. What did NOT reject was a SUCCESSFUL response carrying the
// wrong body, because `api.get<OnboardingState>` is a cast and nothing else.
// Such a body was stored, memoised and handed to `applySkipOverlay`, whose
// guard was `if (!state)` — and `{}` is truthy, so `state.steps.map(...)` threw
// inside `OnboardingProvider`'s render. `Layout.tsx` mounts that provider in
// the SHELL, so React unwound the whole application into `ErrorBoundary`'s
// "Something went wrong" panel, on every page.
//
// The four bodies are the four real sources, not invented awkwardness:
//   • `{}` — a permissive test/mocking catch-all (`return json(route, {})`),
//     which is exactly how ~67 Playwright visual specs went red at once.
//   • `{ steps: null }` — a partial/serialised-wrong body.
//   • an HTML string — a proxy, a CDN error page, or an expired-auth redirect
//     answering 200 with a wrapper page.
//   • junk inside `steps` — the case a guard on the container alone still
//     crashes on, one component further in (`SetupChecklist`).
//
// The assertion is `rejects`, because a rejection is a path every caller
// already handles. See the boundary-validation block in
// `services/onboarding.ts` for why the check lives there and not in a consumer.
// =============================================================================

describe('a 200 that is not a checklist', () => {
  const malformedBodies: [name: string, body: unknown][] = [
    ['an empty object', {}],
    ['a null `steps`', { ...userState(), steps: null }],
    ['a missing `steps`', { audience: 'user', requiredRemaining: 0 }],
    ['an HTML page', '<!doctype html><html><body>Sign in</body></html>'],
    ['a non-object body', 42],
    ['an array body', []],
    [
      'a junk entry inside `steps`',
      { ...userState(), steps: [step(), { nope: true }] },
    ],
    [
      'a step with an unknown `status`',
      { ...userState(), steps: [step({ status: 'elsewhere' as never })] },
    ],
    ['a non-numeric `requiredRemaining`', { ...userState(), requiredRemaining: '2' }],
    ['a non-numeric `totalRemaining`', { ...userState(), totalRemaining: null }],
    [
      'a non-boolean `allRequiredSatisfied`',
      { ...userState(), allRequiredSatisfied: 'yes' },
    ],
    ['an unknown `audience`', { ...userState(), audience: 'robot' }],
  ];

  it.each(malformedBodies)('rejects %s from the user route', async (_name, body) => {
    server.use(
      http.get(`${API_BASE}${ONBOARDING_PATH}`, () => HttpResponse.json({ data: body })),
    );

    await expect(getOnboardingState()).rejects.toThrow(/Malformed onboarding response/);
  });

  it.each(malformedBodies)('rejects %s from the admin route', async (_name, body) => {
    server.use(
      http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () =>
        HttpResponse.json({ data: body }),
      ),
    );

    await expect(getAdminOnboardingState()).rejects.toThrow(
      /Malformed onboarding response/,
    );
  });

  it('names the route in the message, because the two failures look alike', async () => {
    server.use(
      http.get(`${API_BASE}${ADMIN_ONBOARDING_PATH}`, () => HttpResponse.json({ data: {} })),
    );

    // An intermediary wrapping ONE endpoint and a harness answering EVERY
    // endpoint with `{}` are indistinguishable in a console unless the message
    // says which route produced it.
    await expect(getAdminOnboardingState()).rejects.toThrow(ADMIN_ONBOARDING_PATH);
  });
});

// =============================================================================
// The narrowing itself, called directly
// =============================================================================

describe('parseOnboardingState', () => {
  it('returns the very same object for a well-formed body', () => {
    // Identity, not equality: the check narrows, it does not rebuild. A copy
    // here would be a second place the wire shape is reconstructed — and the
    // place a field the client does not know about would be silently dropped.
    const state = userState();
    expect(parseOnboardingState(state, ONBOARDING_PATH)).toBe(state);
  });

  it('accepts a body carrying fields this client does not know about', () => {
    // ⚠ NARROW ON PURPOSE. A server that adds a field must not be turned into a
    // blank checklist by a client built last release; this is a crash guard,
    // not a schema mirror.
    const state = { ...userState(), futureField: 'hello' };
    expect(parseOnboardingState(state, ONBOARDING_PATH)).toBe(state);
  });

  it('accepts an empty checklist, which is a real answer', () => {
    // "Nothing left to set up" is the state a finished deployment reports. An
    // over-eager check that demanded a non-empty `steps` would reject the one
    // body every healthy deployment eventually sends.
    const state = userState({ steps: [] });
    expect(parseOnboardingState(state, ONBOARDING_PATH)).toBe(state);
  });

  it('rejects the whole checklist rather than filtering the bad rows out', () => {
    // A checklist silently missing a required step is worse than no checklist:
    // the banner would read "all done" over a deployment that cannot transcribe.
    expect(() =>
      parseOnboardingState(
        { ...userState(), steps: [step(), null] },
        ONBOARDING_PATH,
      ),
    ).toThrow(/steps/);
  });
});
