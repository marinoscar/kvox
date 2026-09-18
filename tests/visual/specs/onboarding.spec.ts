import { expect, test, type Page, type Route } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { installHomeApi } from '../support/homeApi';
import { onboardingResponse, type OnboardingApiOptions } from '../support/onboardingApi';

/**
 * The onboarding chrome PR #286 mounts on every page — issue #298.
 *
 * =============================================================================
 * WHY THIS SPEC EXISTS AT ALL
 * =============================================================================
 *
 * `OnboardingProvider`, `OnboardingBanner`, `FirstRunWelcomeDialog` and
 * `ReturnToSetupBar` (`components/common/Layout.tsx`) sit above every one of
 * this suite's ~70 existing baselines, and until `support/onboardingApi.ts`
 * every one of them was captured with all four rendering nothing — the
 * default `{}` answer for `/onboarding`/`/admin/onboarding`/`/user-settings`
 * was exactly the shape that produces zero DOM (see that file's header). So
 * nothing in this application has ever pinned what a REAL checklist, a REAL
 * banner or the first-run dialog actually look like. This spec is that
 * baseline, and it is additive: every other spec in this directory keeps
 * asserting nothing about this chrome, on purpose, because it already does not
 * exist for them.
 *
 * =============================================================================
 * WHERE THE FIXTURES COME FROM
 * =============================================================================
 *
 * The banner and welcome-dialog specs reuse `support/homeApi.ts`'s
 * `installHomeApi` and mount the chrome over the signed-in home page — the
 * shell chrome does not care which page it sits above, and Home is the one
 * page in this suite already wired to accept an `onboarding` option (see its
 * own header). The two checklist-page specs (§7) mock only what
 * `OnboardingProvider` itself fetches, through {@link installOnboardingOnlyApi}
 * below — see that function's own comment for why `installHomeApi` is the
 * wrong tool for `/admin/settings/setup`/`/settings/getting-started` even
 * though it would technically work.
 *
 * Every fixture here uses the `'outstanding'` shape from `onboardingApi.ts`,
 * which is the real registry copy under one plausible scenario, not invented
 * text — see that file's header for why that matters to a baseline.
 *
 * =============================================================================
 * A REAL DOM ASSERTION BEFORE EVERY SCREENSHOT
 * =============================================================================
 *
 * Every test below asserts a landmark or a heading BY NAME before its
 * `toHaveScreenshot`, so a regression that made the chrome fail to appear (a
 * bad gate, a broken fetch, a typo in `chooseBannerAudience`) fails as "the
 * banner never appeared" rather than as an opaque pixel diff.
 *
 * ⚠ EVERY HOME-PAGE CAPTURE ALSO WAITS ON HOME'S OWN GREETING HEADING, exactly
 * as `home.spec.ts` does, and for the identical reason: the summary fetch that
 * decides the page body's content is a SEPARATE, independently-settling
 * request from the two onboarding reads (see `OnboardingContext.tsx`'s
 * `Promise.allSettled`), so a full-page capture of the banner, the dialog or
 * the return-to-setup bar could otherwise race Home's own skeleton state —
 * fully visible beside the banner and the return bar, and showing through a
 * translucent dialog backdrop.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

/**
 * A minimal `/api` mock for the two checklist PAGES themselves.
 *
 * ⚠ NOT `installHomeApi`, DELIBERATELY, even though it would work: that
 * installer's whole reason to exist is a fixture matrix for
 * `/transcripts/summary`, `/notes/summary` and `/transcription/config` (see
 * its own header) that `SetupPage` and `GettingStartedPage` never call — both
 * pages read `OnboardingProvider`'s own state and call its `refresh()` on
 * mount, issuing no request of their own beyond the three
 * `onboardingResponse` already answers. Routing these two specs through
 * `installHomeApi` would pass, by accident, and would leave a reader of this
 * file wondering what a home-page transcript fixture has to do with the
 * deployment setup checklist. This is the narrowest mock that is still
 * correct for both routes — the same shape every installer in this suite
 * ends its own `page.route` chain with (see `support/homeApi.ts`'s `json`).
 */
async function installOnboardingOnlyApi(
  page: Page,
  options: OnboardingApiOptions = {},
): Promise<void> {
  function json(route: Route, data: unknown) {
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ data }),
    });
  }

  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');

    const onboarding = onboardingResponse(path, options);
    if (onboarding) return json(route, onboarding);

    return json(route, {});
  });
}

test.describe('Onboarding — shell banner', () => {
  test('admin banner over Home @ 1440x900', async ({ page }) => {
    // `adminDismissed: false` is required — the fixture defaults to dismissed
    // (see `onboardingApi.ts`'s header) specifically so the ~70 pre-existing
    // baselines stay unaffected, which means every spec that wants the banner
    // visible has to ask for that explicitly.
    await installHomeApi(page, {
      onboarding: { admin: 'outstanding', adminDismissed: false },
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    // Home's own content has settled — see the file header on why this
    // matters for a full-page capture even though this test is about the
    // banner, not the page underneath it.
    await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();

    // The banner's `<section>` is named by its (visually hidden) landmark
    // text, not by the headline it renders — `chooseBannerAudience`'s two
    // possible answers, `BANNER_COPY.admin.landmark` / `.user.landmark`, are
    // fixed strings independent of the step counts, which is what makes this
    // assertion resilient to the fixture's own numbers changing later.
    await expect(page.getByRole('region', { name: 'Deployment setup' })).toBeVisible();
    // `role: 'link'`, NOT `'button'` — `OnboardingBanner.tsx` renders this as
    // `<Button component={RouterLink} to={copy.path} …>`, which MUI emits as
    // an `<a href>`. An anchor's implicit ARIA role is `link` regardless of
    // how it is styled, so this queries the accessible role rather than the
    // look of the control.
    await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-admin-banner-1440x900.png');
  });

  test('user banner over Home @ 1440x900', async ({ page }) => {
    await installHomeApi(page, {
      onboarding: { user: 'outstanding', userDismissed: false },
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();

    await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible();
    // `role: 'link'` — see the identical comment on the admin banner test
    // above; the same `<Button component={RouterLink}>` renders an anchor.
    await expect(page.getByRole('link', { name: 'Continue' })).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-user-banner-1440x900.png');
  });

  test('user banner over Home @ 390x844 (phone)', async ({ page }) => {
    // `Layout.tsx`'s coupled breakpoint gates sit at `sm` (600px), and the
    // banner's own `Stack` reflows from a row to a column below it — a phone
    // capture is the only one of these that can see that reflow break.
    await installHomeApi(page, {
      onboarding: { user: 'outstanding', userDismissed: false },
    });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();

    await expect(page.getByRole('region', { name: 'Getting started' })).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-user-banner-390x844.png');
  });

  test('admin-wins precedence: both checklists outstanding, neither dismissed @ 1440x900', async ({
    page,
  }) => {
    // Both audiences qualify (outstanding AND undismissed) at once — the one
    // scenario `chooseBannerAudience`'s admin-first `if` chain actually has to
    // resolve, and the one no single-flag fixture could ever produce (see
    // `onboardingApi.ts`'s header on why the two dismissal booleans are
    // separate).
    await installHomeApi(page, {
      onboarding: {
        admin: 'outstanding',
        user: 'outstanding',
        adminDismissed: false,
        userDismissed: false,
      },
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();

    // The admin copy renders...
    await expect(page.getByRole('region', { name: 'Deployment setup' })).toBeVisible();
    // ...and the user checklist's banner does not — ONE banner, never two
    // stacked (see `OnboardingBanner`'s header). Asserting the negative is the
    // whole point of this test; without it, a regression that rendered both
    // would still pass every other assertion here.
    await expect(page.getByRole('region', { name: 'Getting started' })).toHaveCount(0);

    await expect(page).toHaveScreenshot('onboarding-admin-wins-1440x900.png');
  });
});

test.describe('Onboarding — first-run welcome dialog', () => {
  // Both panes are captured over the SAME fixture (`welcomeSeen: false`, a
  // real outstanding user checklist so `FirstRunWelcomeDialog`'s third gate —
  // `onboarding.user` non-null — is satisfied) since the dialog's `due` gate
  // reads no step count at all (see `WelcomeDialog.tsx`'s header): what is
  // outstanding never changes what the dialog itself renders.
  const WELCOME_FIXTURE: { onboarding: OnboardingApiOptions } = {
    onboarding: { user: 'outstanding', welcomeSeen: false },
  };

  test('welcome dialog: "what" pane @ 1440x900', async ({ page }) => {
    await installHomeApi(page, WELCOME_FIXTURE);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    // ⚠ NO "Hi, Visual" ASSERTION HERE, DELIBERATELY, unlike the banner/return-
    // bar tests above. MUI's `Dialog` is modal and applies `aria-hidden` to
    // the rest of the app while open (`WelcomeDialog.tsx` passes none of the
    // props — `disableEnforceFocus`, a custom `ModalManager`, etc. — that
    // would turn that off), so Home's greeting heading leaves the
    // accessibility tree for as long as the dialog is up and
    // `getByRole('heading', …)` cannot find it. The dialog's own visibility
    // (asserted next) is the readiness signal here — Home's greeting is
    // neither available nor needed as one.
    await expect(page.getByRole('dialog')).toBeVisible();
    // The title is `Welcome to ${APP_NAME}` (`WELCOME_PANES[0].title`) — a
    // regex rather than the literal string, since this spec has no access to
    // the brand token the app itself reads at build time.
    await expect(page.getByRole('heading', { name: /^Welcome to /i })).toBeVisible();
    await expect(page.getByText('Step 1 of 3')).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-welcome-dialog-what-1440x900.png');
  });

  test('welcome dialog: BYOK pane @ 1440x900', async ({ page }) => {
    await installHomeApi(page, WELCOME_FIXTURE);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/' }));
    await waitForInter(page);
    // No "Hi, Visual" assertion here either — see the identical comment on
    // the "what" pane test above. `Next` (asserted immediately below) is this
    // test's readiness signal instead.

    // Assert the control exists (and is on the first pane) BEFORE clicking
    // it — a `Next` that never rendered would otherwise fail as a Playwright
    // "element not found" on `.click()`, which is a strictly worse message
    // than "the button never appeared" for the same underlying regression.
    const next = page.getByRole('button', { name: 'Next' });
    await expect(next).toBeVisible();
    await next.click();

    await expect(page.getByRole('heading', { name: 'AI runs on your own provider key' })).toBeVisible();
    await expect(page.getByText('Step 2 of 3')).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-welcome-dialog-byok-1440x900.png');
  });
});

test.describe('Onboarding — return-to-setup bar', () => {
  test('return-to-setup bar over Home, driven by ?setup= @ 1440x900', async ({ page }) => {
    // The marker travels on the APP route, inside the harness's own `route=`
    // param — `harnessUrl` round-trips it intact because `URLSearchParams`
    // percent-encodes the embedded `?`/`=` on the way out and
    // `visual/main.tsx`'s `search.get('route')` decodes it back to the exact
    // same string on the way in.
    //
    // ⚠ HOME, NOT `/settings/getting-started`. That path IS
    // `GETTING_STARTED_PATH` — the bar's own `hubPath` for the `user`
    // audience — and `ReturnToSetupBar` suppresses itself on the hub page
    // itself (see its header), so pointing the marker at the checklist page
    // it names would render nothing at all.
    await installHomeApi(page, {
      onboarding: { user: 'outstanding' },
    });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/?setup=user.first_transcript' }));
    await waitForInter(page);
    await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();

    const bar = page.getByRole('region', { name: 'Setup in progress' });
    await expect(bar).toBeVisible();
    // The step's own title from the fixture's checklist, never the raw query
    // parameter (see `ReturnToSetupBar.tsx`'s header on why that distinction
    // is load-bearing for safety, not just for this assertion).
    await expect(bar.getByText('Transcribe your first recording')).toBeVisible();
    await expect(bar.getByRole('link', { name: 'Back to setup' })).toBeVisible();

    await expect(page).toHaveScreenshot('onboarding-return-to-setup-bar-1440x900.png');
  });
});

test.describe('Onboarding — the two checklist pages', () => {
  test('deployment setup, outstanding @ 1440x900', async ({ page }) => {
    await installOnboardingOnlyApi(page, { admin: 'outstanding' });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/admin/settings/setup' }));
    await waitForInter(page);

    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Setup', level: 1 })).toBeVisible();
    // One required, `pending` row and one `blocked` row — the two shapes
    // `SetupChecklist` renders differently (see its own header) — both
    // present in one capture.
    //
    // `getByRole('heading', …)`, NOT `getByText`, for the step's own title:
    // `admin.smoke_test`'s `blockedReason` in `onboarding-steps.ts` is
    // "Connect a transcription provider first — there is nothing to send a
    // recording to yet.", which begins with the exact same words as this
    // step's title (`SetupChecklist.tsx`'s `StepRow` renders the title as an
    // `<h3>` and the reason as a plain `<p>`) — a plain `getByText` matches
    // both and is a strict-mode violation. Scoping to the heading role is
    // what makes the query unique.
    await expect(
      main.getByRole('heading', { name: 'Connect a transcription provider' }),
    ).toBeVisible();
    // `getByText` is fine here: the fixture has exactly one `blocked` step,
    // so `STATUS_LABELS.blocked` ("Waiting on your administrator") renders
    // once and collides with no other row's title, description or reason.
    await expect(main.getByText('Waiting on your administrator')).toBeVisible();

    await expect(page).toHaveScreenshot('admin-setup-checklist-1440x900.png', {
      fullPage: true,
    });
  });

  test('getting started, outstanding @ 1440x900', async ({ page }) => {
    await installOnboardingOnlyApi(page, { user: 'outstanding' });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/settings/getting-started' }));
    await waitForInter(page);

    const main = page.locator('main');
    await expect(main.getByRole('heading', { name: 'Getting Started', level: 1 })).toBeVisible();
    await expect(main.getByText('Add your AI provider key')).toBeVisible();
    // The BYOK explainer that is the entire reason this page exists (see
    // `GettingStartedPage.tsx`'s header) — above the checklist, in the same
    // capture.
    await expect(
      main.getByRole('heading', { name: 'About AI features and your own key' }),
    ).toBeVisible();

    await expect(page).toHaveScreenshot('getting-started-checklist-1440x900.png', {
      fullPage: true,
    });
  });
});
