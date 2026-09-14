import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { installTranscriptsApi } from '../support/transcriptsApi';

/**
 * The correction UI and the version history — issue #31, epic #19.
 *
 * A SIBLING of `transcripts.spec.ts`, which baselines the READER at the same
 * three widths. These specs cover what #31 adds on top of it, at the two widths
 * where the treatments genuinely differ: 390 (bottom sheets, one column, the
 * mini player) and 1440 (anchored menus, the two-column split, the side panel).
 * 820 is deliberately absent here — the tablet band is already proven to take
 * the wide treatment by `transcripts.spec.ts`, and #31 adds no third layout for
 * it to break differently.
 *
 * ⚠ LOCATORS ARE EXACT OR SCOPED, WITHOUT EXCEPTION. `getByRole(..., { name })`
 * matches a SUBSTRING of the accessible name, so `{ name: 'Play' }` in this
 * application matches fifteen "Play from 0:04" buttons and fails as a strict
 * mode violation. Every name below is either `exact: true` or a full sentence
 * that cannot be a prefix of another control's.
 *
 * ⚠ NOTHING HERE PRESSES PLAY, for the same reason the reader specs do not: a
 * moving playhead is a different screenshot on every run.
 */

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };

test.describe('Transcript editor', () => {
  test('segment overflow sheet @ phone-390', async ({ page }) => {
    // The bottom sheet IS the phone treatment of the segment menu, and it is
    // the surface that would silently regress if the `sm` gate ever moved.
    await installTranscriptsApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for the line at 0:00' }).click();
    await expect(page.getByRole('menuitem', { name: 'Change speaker' })).toBeVisible();

    await expect(page).toHaveScreenshot('transcript-segment-sheet-phone-390.png');
  });

  test('speaker sheet, ready to merge @ phone-390', async ({ page }) => {
    // Tap one, tap "Merge into…": the second of the three taps the vision
    // budgets for the merge, with the target list on screen.
    await installTranscriptsApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await page.getByRole('button', { name: 'Actions for Ana Ruiz' }).click();
    await page.getByRole('menuitem', { name: 'Merge into…' }).click();
    await expect(
      page.getByRole('menuitem', { name: 'Merge Ana Ruiz into Ben Olsen' }),
    ).toBeVisible();

    await expect(page).toHaveScreenshot('transcript-speaker-sheet-phone-390.png');
  });

  test('speakers panel with two ticked for merge @ desktop-1440', async ({ page }) => {
    await installTranscriptsApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await page.getByRole('checkbox', { name: 'Select Ana Ruiz to merge' }).check();
    await page.getByRole('checkbox', { name: 'Select Ben Olsen to merge' }).check();
    await expect(page.getByRole('button', { name: 'Merge 2 speakers' })).toBeEnabled();

    await expect(page).toHaveScreenshot('transcript-merge-selection-desktop-1440.png');
  });

  test('find & replace panel with matches @ desktop-1440', async ({ page }) => {
    await installTranscriptsApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await page.getByRole('button', { name: 'Find and replace' }).click();
    await page.getByLabel('Find', { exact: true }).fill('migration');
    // The count is what settles last — waiting on it keeps the capture off the
    // frame where the search has not answered.
    await expect(page.getByText('1 of 6')).toBeVisible();

    await expect(page).toHaveScreenshot('transcript-find-replace-desktop-1440.png');
  });

  test('find & replace sheet @ phone-390', async ({ page }) => {
    await installTranscriptsApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/transcripts/t1' }));
    await waitForInter(page);

    await expect(page.getByRole('region', { name: 'Transcript' })).toBeVisible();
    await page.getByRole('button', { name: 'Find and replace' }).click();
    await page.getByLabel('Find', { exact: true }).fill('migration');
    await expect(page.getByText('1 of 6')).toBeVisible();

    await expect(page).toHaveScreenshot('transcript-find-replace-phone-390.png');
  });
});

test.describe('Version history', () => {
  for (const [name, viewport] of [
    ['phone-390', PHONE],
    ['desktop-1440', DESKTOP],
  ] as const) {
    test(`history @ ${name}`, async ({ page }) => {
      await installTranscriptsApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/transcripts/t1/history' }));
      await waitForInter(page);

      await expect(page.getByRole('heading', { name: 'Version history' })).toBeVisible();
      // The grouping and the badge are the two things this baseline exists for.
      await expect(page.getByText('AI original')).toBeVisible();
      await expect(
        page.getByText('Edited 2 segments · Merged Speaker 3 into Ana Ruiz'),
      ).toBeVisible();

      await expect(page).toHaveScreenshot(`transcript-history-${name}.png`);
    });
  }

  test('version preview @ desktop-1440', async ({ page }) => {
    await installTranscriptsApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/transcripts/t1/history' }));
    await waitForInter(page);

    await page.getByRole('button', { name: 'Version 1' }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('region', { name: 'Transcript' })).toBeVisible();

    await expect(page).toHaveScreenshot('transcript-version-preview-desktop-1440.png');
  });
});
