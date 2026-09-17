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
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { http, HttpResponse } from 'msw';

import { server } from '../mocks/server';
import {
  ADMIN_ONBOARDING_PATH,
  ONBOARDING_PATH,
  getAdminOnboardingState,
  getOnboardingState,
} from '../../services/onboarding';
import { adminState, userState } from '../components/onboarding/onboardingFixtures';

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
