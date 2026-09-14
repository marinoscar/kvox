import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { installTranscriptsApi } from '../support/transcriptsApi';

/**
 * The three transcript screens at the three widths issue #30 names — phone
 * (390px), tablet (820px) and desktop (1440px).
 *
 * THOSE THREE WIDTHS ARE NOT ARBITRARY, and picking them is half the value of
 * this spec: 390 and 820 sit either side of the `sm` (600px) boundary that
 * `common/Layout.tsx` documents as the first of five coupled gates, and 820
 * specifically is a tablet in portrait — the band that a `md`-gated (900px)
 * layout would wrongly hand the phone treatment to. So each page is captured
 * with the bottom bar and the mini player (390), with the rail and no bottom
 * bar (820), and with the rail plus the viewer's two-column split (1440).
 *
 * FULL-PAGE CAPTURES, unlike the nav specs in this directory. Those scope to
 * the `nav` element precisely so the page body's unmocked `/api` calls cannot
 * reach a baseline; these specs ARE the page body, and they mock the API
 * instead — see `support/transcriptsApi.ts`.
 *
 * ⚠ THE PLAYER IS PAUSED IN EVERY BASELINE, and nothing here presses play. A
 * moving playhead is a different screenshot on every run: the scrubber thumb
 * moves, the current-segment highlight moves, and auto-follow scrolls the list
 * underneath it. What these baselines protect is the LAYOUT of the transport,
 * not its behaviour — the behaviour is `usePlaybackEngine`'s own suite, which
 * can assert it deterministically against a fake element.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

test.describe('Transcripts library', () => {
  for (const [name, viewport] of [
    ['phone-390', PHONE],
    ['tablet-820', TABLET],
    ['desktop-1440', DESKTOP],
  ] as const) {
    test(`library @ ${name}`, async ({ page }) => {
      await installTranscriptsApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/transcripts' }));
      await waitForInter(page);

      // Waiting on the CONTENT, not on a network-idle heuristic: the list is
      // rendered by a hook that also polls, so "idle" is a moving target.
      await expect(
        page.getByRole('heading', { name: 'Weekly engineering standup' }),
      ).toBeVisible();
      // The processing row's chip is the one piece of this screen that is
      // asynchronous in its own right; waiting for it keeps the capture off
      // the frame where it has not resolved.
      await expect(page.getByText(/Processing · Transcribing/)).toBeVisible();

      await expect(page).toHaveScreenshot(`transcripts-library-${name}.png`);
    });
  }

  test('library empty state @ phone-390', async ({ page }) => {
    // The empty state is the screen a brand-new user meets first, and it is
    // the one most likely to be quietly broken by a layout change nobody
    // notices — every other baseline here has rows to hold the page open.
    await installTranscriptsApi(page, { empty: true });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/transcripts' }));
    await waitForInter(page);

    await expect(page.getByRole('heading', { name: 'No transcripts yet' })).toBeVisible();

    await expect(page).toHaveScreenshot('transcripts-library-empty-phone-390.png');
  });
});

test.describe('New transcript', () => {
  for (const [name, viewport] of [
    ['phone-390', PHONE],
    ['tablet-820', TABLET],
    ['desktop-1440', DESKTOP],
  ] as const) {
    test(`new transcript @ ${name}`, async ({ page }) => {
      await installTranscriptsApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/transcripts/new' }));
      await waitForInter(page);

      await expect(page.getByText('Choose audio')).toBeVisible();
      // The capability probe gates the whole screen, so the drop zone only
      // exists once it has answered.
      await expect(page.getByLabel('Choose an audio file')).toBeVisible();

      await expect(page).toHaveScreenshot(`transcripts-new-${name}.png`);
    });
  }
});

test.describe('Transcript viewer', () => {
  for (const [name, viewport] of [
    ['phone-390', PHONE],
    ['tablet-820', TABLET],
    ['desktop-1440', DESKTOP],
  ] as const) {
    test(`viewer @ ${name}`, async ({ page }) => {
      await installTranscriptsApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/transcripts/t1' }));
      await waitForInter(page);

      await expect(
        page.getByRole('heading', { name: 'Weekly engineering standup' }),
      ).toBeVisible();
      await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
      // The player only mounts once `GET /:id/audio` has answered AND the
      // browser has accepted the source — capturing before that would bake the
      // "Preparing audio…" notice into a baseline meant to show the transport.
      await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
      // The duration readout is the last thing to settle (it comes from
      // `loadedmetadata`), and it is on screen in every one of these captures.
      await expect(page.getByText('0:00 / 0:48')).toBeVisible();

      await expect(page).toHaveScreenshot(`transcripts-viewer-${name}.png`);
    });
  }

  test('viewer with a speaker filter active @ desktop-1440', async ({ page }) => {
    // The "Only: Ana Ruiz" chip, the filled speaker row, and the dimmed
    // segments of everyone else — the visual half of the feature this issue
    // exists for, and the part no unit test can look at.
    await installTranscriptsApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Play only Ana Ruiz' }).click();
    await expect(page.getByText('Only: Ana Ruiz')).toBeVisible();

    await expect(page).toHaveScreenshot('transcripts-viewer-speaker-filter-desktop-1440.png');
  });

  test('viewer pipeline stepper @ phone-390', async ({ page }) => {
    // What a user stares at for the minutes a provider takes, which makes it
    // the highest-traffic state of this page and the one with no content of
    // its own to hold the layout together.
    await installTranscriptsApi(page, { processing: true });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByText('Transcribing', { exact: true })).toBeVisible();

    await expect(page).toHaveScreenshot('transcripts-viewer-processing-phone-390.png');
  });

  test('viewer pipeline stepper @ desktop-1440', async ({ page }) => {
    // The stepper flips from vertical to horizontal at `sm`, so one width
    // cannot cover it.
    await installTranscriptsApi(page, { processing: true });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByText('Transcribing', { exact: true })).toBeVisible();

    await expect(page).toHaveScreenshot('transcripts-viewer-processing-desktop-1440.png');
  });
});
