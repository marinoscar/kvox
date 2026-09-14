import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { installHomeApi } from '../support/homeApi';

/**
 * The signed-in home page — issue #32, epic #19.
 *
 * =============================================================================
 * THREE WIDTHS × TWO THEMES, AND WHY BOTH AXES ARE NEEDED
 * =============================================================================
 *
 * The widths are the same three `transcripts.spec.ts` uses, for the same
 * reason: 390 and 820 sit either side of the `sm` (600px) boundary that
 * `common/Layout.tsx` documents as the first of five coupled gates, and 820
 * specifically is a tablet in portrait — the band a `md`-gated (900px) layout
 * would wrongly hand the phone treatment to. 1440 is the third column count.
 *
 * ⚠ THIS PAGE'S LAYOUT IS ENTIRELY CSS, WHICH IS EXACTLY WHY IT NEEDS PIXELS.
 * `RecentTranscripts` and `SharedWithMe` reflow from one column to two to three
 * to four purely through `Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }}` — there
 * is no `useMediaQuery` anywhere on the page, deliberately, so that the five
 * coupled breakpoint gates stay five. jsdom performs no layout at all, so the
 * Vitest suite cannot observe a column count: a regression that collapsed the
 * desktop grid to a single column would leave every unit test green. These
 * baselines are the only thing that can see it.
 *
 * The THEME axis is new to this suite and is not decoration either. The cards,
 * the stage chips, the "Coming soon" chips and the dimmed journey stages all
 * carry their own surface treatment, and `opacity: 0.6` over a near-black
 * ground is a very different result from the same value over white. Every
 * other spec in this directory captures the harness default (dark) only; this
 * page is the app's landing screen in both modes, so it is captured in both.
 *
 * FULL-PAGE CAPTURES, like the transcript specs and unlike the nav ones: this
 * spec IS the page body, so there is nothing to scope away, and the API is
 * mocked instead — see `support/homeApi.ts`.
 *
 * ⚠ NO LOCAL UPLOAD APPEARS IN ANY BASELINE. A live upload's row is driven by
 * the upload manager's in-memory progress, not by anything on the wire, so it
 * cannot be installed through `page.route` — and a moving byte counter and
 * progress bar would be a different screenshot on every run if it could. The
 * in-flight baseline captures the server-side half (the stage chips), which is
 * what this mock can pin exactly; the local half is asserted in
 * `apps/web/src/__tests__/components/home/InProgressSection.test.tsx`, where a
 * fixed progress snapshot can be handed in directly.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

const VIEWPORTS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['desktop-1440', DESKTOP],
] as const;

const THEMES = ['light', 'dark'] as const;

test.describe('Home — populated', () => {
  for (const [name, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`home @ ${name} ${theme}`, async ({ page }) => {
        await installHomeApi(page);
        await page.setViewportSize(viewport);
        await page.goto(harnessUrl({ route: '/', theme }));
        await waitForInter(page);

        // Waiting on CONTENT, not on a network-idle heuristic: the summary is
        // fetched by a hook that also polls, so "idle" is a moving target.
        // The greeting only renders once the first read has settled, which is
        // precisely the frame after the skeleton.
        await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Recent', exact: true })).toBeVisible();
        // `Shared with me` is the last section on the page, so its presence
        // means everything above it has rendered too.
        await expect(
          page.getByRole('heading', { name: 'Shared with me', exact: true }),
        ).toBeVisible();
        // The capability probe gates the hero's button; capturing before it
        // answers would bake the disabled state into a baseline meant to show
        // the working one.
        await expect(
          page.getByRole('button', { name: 'New transcript', exact: true }),
        ).toBeEnabled();

        await expect(page).toHaveScreenshot(`home-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Home — the journey empty state', () => {
  for (const [name, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`home empty @ ${name} ${theme}`, async ({ page }) => {
        // The screen a brand-new account meets first, and the one most likely
        // to be quietly broken by a layout change nobody notices — every other
        // baseline here has rows to hold the page open.
        await installHomeApi(page, { fixture: 'empty' });
        await page.setViewportSize(viewport);
        await page.goto(harnessUrl({ route: '/', theme }));
        await waitForInter(page);

        await expect(page.getByRole('heading', { name: 'Start here' })).toBeVisible();
        // The fourth and last stage card — everything before it is laid out.
        await expect(page.getByRole('heading', { name: 'Find', exact: true })).toBeVisible();
        // TWO buttons exist in this state (hero + journey), so an inexact
        // `getByRole` would be strict-mode-violating rather than merely vague.
        await expect(
          page.getByRole('button', { name: 'New transcript', exact: true }).first(),
        ).toBeEnabled();

        await expect(page).toHaveScreenshot(`home-empty-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Home — work in flight', () => {
  for (const [name, viewport] of VIEWPORTS) {
    for (const theme of THEMES) {
      test(`home in progress @ ${name} ${theme}`, async ({ page }) => {
        await installHomeApi(page, { fixture: 'in-progress' });
        await page.setViewportSize(viewport);
        await page.goto(harnessUrl({ route: '/', theme }));
        await waitForInter(page);

        await expect(page.getByRole('heading', { name: 'In progress' })).toBeVisible();
        // The two stage chips are the whole point of this baseline: they are
        // the difference between "something is happening" and "here is what is
        // happening". `exact` because "Preparing audio" is a substring of
        // nothing here today but trivially could be tomorrow.
        await expect(page.getByText('Transcribing', { exact: true })).toBeVisible();
        await expect(page.getByText('Preparing audio', { exact: true })).toBeVisible();

        await expect(page).toHaveScreenshot(`home-in-progress-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Home — transcription not configured', () => {
  // Phone and desktop only, and light only. What this baseline protects is the
  // stack of three elements the blocked state adds under the hero — the
  // disabled button, the explanation, and the admin's set-up link — which is a
  // vertical-rhythm question, not a colour or a column-count one. The other
  // four combinations would be four more baselines asserting the same three
  // boxes at the same two widths.
  for (const [name, viewport] of [
    ['phone-390', PHONE],
    ['desktop-1440', DESKTOP],
  ] as const) {
    test(`home unconfigured @ ${name} light`, async ({ page }) => {
      await installHomeApi(page, { transcriptionUnavailable: true });
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/', theme: 'light' }));
      await waitForInter(page);

      await expect(page.getByRole('heading', { name: 'Hi, Visual' })).toBeVisible();
      await expect(
        page.getByRole('button', { name: 'New transcript', exact: true }),
      ).toBeDisabled();
      // The harness user holds `system_settings:read`, so the admin escape
      // hatch is part of this capture.
      await expect(
        page.getByRole('button', { name: 'Set up transcription', exact: true }),
      ).toBeVisible();

      await expect(page).toHaveScreenshot(`home-unconfigured-${name}-light.png`);
    });
  }
});
