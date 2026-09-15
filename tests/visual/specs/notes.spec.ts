import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { installNotesApi } from '../support/notesApi';

/**
 * The note screens at the three widths issue #57 names — phone (390px), tablet
 * (820px) and desktop (1440px).
 *
 * THOSE THREE WIDTHS ARE NOT ARBITRARY, for the reason `transcripts.spec.ts`
 * states at length: 390 and 820 sit either side of the `sm` (600px) boundary
 * that `common/Layout.tsx` documents as the first of five coupled gates, and
 * 820 specifically is a tablet in portrait — the band a `md`-gated (900px)
 * layout would wrongly hand the phone treatment to. So each screen is captured
 * with the bottom bar (390), with the rail and no bottom bar (820), and with
 * the rail at desktop width (1440).
 *
 * ⚠ THE LIBRARY IS CAPTURED ON BOTH TABS, because #57's central claim is that
 * the tab is the URL: `/transcripts` and `/notes` are two routes onto one page,
 * and a baseline of only one of them would say nothing about the other.
 *
 * ⚠ AND THE GENERATION VIEW IS CAPTURED MID-STREAM, deliberately. The stream is
 * served complete and then ended (see `support/notesApi.ts`), so the page shows
 * a fixed amount of rendered markdown with the "Writing your note…" panel still
 * on screen — which is the state a user actually stares at, and the one with no
 * settled content of its own to hold the layout together.
 */

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const DESKTOP = { width: 1440, height: 900 };

const WIDTHS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['desktop-1440', DESKTOP],
] as const;

test.describe('Notes list', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`notes library @ ${name}`, async ({ page }) => {
      await installNotesApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes' }));
      await waitForInter(page);

      // Waiting on the CONTENT, not on a network-idle heuristic: the list is
      // rendered by a hook that also polls while anything is generating, so
      // "idle" is a moving target.
      await expect(
        page.getByRole('heading', { name: 'Weekly engineering standup — minutes' }),
      ).toBeVisible();
      // The source name is resolved by a SECOND request per distinct source,
      // so waiting for it keeps the capture off the frame where the rows still
      // read "from a transcript".
      await expect(
        page.getByRole('link', { name: 'Weekly engineering standup' }).first(),
      ).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-library-${name}.png`);
    });
  }

  test('notes library empty state @ phone-390', async ({ page }) => {
    // The screen a brand-new user meets first, and the one most likely to be
    // quietly broken by a layout change nobody notices — every other baseline
    // here has rows to hold the page open.
    await installNotesApi(page, { empty: true });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/notes' }));
    await waitForInter(page);

    await expect(page.getByRole('heading', { name: 'No notes yet' })).toBeVisible();

    await expect(page).toHaveScreenshot('notes-library-empty-phone-390.png');
  });
});

test.describe('New note', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`new note @ ${name}`, async ({ page }) => {
      await installNotesApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes/new' }));
      await waitForInter(page);

      // The AI-key probe gates the whole screen, so the form only exists once
      // it has answered.
      await expect(page.getByRole('heading', { name: 'New note' })).toBeVisible();
      await expect(page.getByText('What are you writing from?')).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-new-${name}.png`);
    });
  }

  test('new note with no AI key @ desktop-1440', async ({ page }) => {
    // `AiKeyRequired` and nothing else — the rule every AI surface in this epic
    // follows, and the one state of this screen with no form in it at all.
    await installNotesApi(page, { noKey: true });
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/notes/new' }));
    await waitForInter(page);

    await expect(
      page.getByRole('heading', { name: 'Add your AI key to use this' }),
    ).toBeVisible();

    await expect(page).toHaveScreenshot('notes-new-no-key-desktop-1440.png');
  });
});

test.describe('Note generation view', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`generating @ ${name}`, async ({ page }) => {
      await installNotesApi(page, { generating: true });
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes/n1' }));
      await waitForInter(page);

      await expect(page.getByText('Writing your note…')).toBeVisible();
      // The streamed markdown, rendered. Waiting on the TABLE specifically:
      // it is the last block in the fixture, so it is on screen only once the
      // whole delta has been parsed and rendered.
      await expect(page.getByRole('table')).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-generating-${name}.png`);
    });
  }

  test('finished note @ desktop-1440', async ({ page }) => {
    await installNotesApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/notes/n1' }));
    await waitForInter(page);

    await expect(page.getByText('Ready')).toBeVisible();
    await expect(page.getByRole('table')).toBeVisible();

    await expect(page).toHaveScreenshot('notes-ready-desktop-1440.png');
  });

  test('failed generation @ phone-390', async ({ page }) => {
    // The recorded reason plus Regenerate — never a bare "something went
    // wrong", and the state most worth a baseline because its layout is an
    // alert with an action inside it.
    await installNotesApi(page, { failed: true });
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/notes/n1' }));
    await waitForInter(page);

    await expect(page.getByText('This note could not be generated')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Regenerate' })).toBeVisible();

    await expect(page).toHaveScreenshot('notes-failed-phone-390.png');
  });
});

// =============================================================================
// #58 — the detail page, the editor, and the history
// =============================================================================

/**
 * Three screens at the same three widths, for the same reason the ones above
 * are captured there: 390 and 820 sit either side of the `sm` (600px) boundary
 * that gates the rail, the bottom bar and every dialog's `fullScreen`, and 820
 * is specifically the tablet band a `md`-gated layout would wrongly hand the
 * phone treatment to.
 *
 * ⚠ THE EDITOR IS CAPTURED AS A TEXTAREA, DELIBERATELY. A note is markdown all
 * the way down — storage, model output, export source — and the baseline is
 * partly there so that a future change to a rich-text surface cannot land
 * silently.
 */

test.describe('Note detail', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`note detail @ ${name}`, async ({ page }) => {
      await installNotesApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes/n1' }));
      await waitForInter(page);

      // The PROVENANCE line resolved to a name, not the fallback noun — it
      // needs a second request per source, so waiting for it keeps the capture
      // off the frame that still reads "from a transcript".
      await expect(
        page.getByRole('link', { name: 'Weekly engineering standup' }),
      ).toBeVisible();
      await expect(page.getByRole('table')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Edit' })).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-detail-${name}.png`);
    });
  }
});

test.describe('Note editor', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`note editor @ ${name}`, async ({ page }) => {
      await installNotesApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes/n1' }));
      await waitForInter(page);

      await page.getByRole('button', { name: 'Edit' }).click();

      await expect(page.getByRole('textbox', { name: 'Note' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-edit-${name}.png`);
    });
  }

  test('note editor preview @ desktop-1440', async ({ page }) => {
    // The other half of the toggle. Worth its own baseline because it is a
    // different renderer in the same box, and a layout change that broke it
    // would be invisible in the write-mode capture above.
    await installNotesApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/notes/n1' }));
    await waitForInter(page);

    await page.getByRole('button', { name: 'Edit' }).click();
    await page.getByRole('button', { name: 'Preview' }).click();

    await expect(page.getByTestId('note-preview')).toBeVisible();

    await expect(page).toHaveScreenshot('notes-edit-preview-desktop-1440.png');
  });
});

test.describe('Note history', () => {
  for (const [name, viewport] of WIDTHS) {
    test(`note history @ ${name}`, async ({ page }) => {
      await installNotesApi(page);
      await page.setViewportSize(viewport);
      await page.goto(harnessUrl({ route: '/notes/n1/history' }));
      await waitForInter(page);

      // ⚠ "Original (AI)" IS THE LABEL THIS BASELINE EXISTS TO PROTECT, beside
      // the version-1 row whose `author` is null.
      await expect(page.getByText('Original (AI)')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Read version 1' })).toBeVisible();

      await expect(page).toHaveScreenshot(`notes-history-${name}.png`);
    });
  }

  test('note history with a version open @ desktop-1440', async ({ page }) => {
    await installNotesApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/notes/n1/history' }));
    await waitForInter(page);

    await page.getByRole('button', { name: 'Read version 1' }).click();

    await expect(page.getByRole('heading', { name: /Version 1 — the AI/ })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restore this version' })).toBeVisible();

    await expect(page).toHaveScreenshot('notes-history-version-desktop-1440.png');
  });
});

test.describe('Note export dialog', () => {
  test('export dialog @ phone-390', async ({ page }) => {
    // `fullScreen` below `sm` — the phone treatment MUI applies at 600px, and
    // the width at which a dialog either fits or does not.
    await installNotesApi(page);
    await page.setViewportSize(PHONE);
    await page.goto(harnessUrl({ route: '/notes/n1' }));
    await waitForInter(page);

    await page.getByRole('button', { name: 'Export' }).click();

    await expect(page.getByRole('radio', { name: 'Markdown' })).toBeVisible();
    await expect(page.getByRole('radio', { name: 'Word' })).toBeVisible();

    await expect(page).toHaveScreenshot('notes-export-dialog-phone-390.png');
  });

  test('export dialog @ desktop-1440', async ({ page }) => {
    await installNotesApi(page);
    await page.setViewportSize(DESKTOP);
    await page.goto(harnessUrl({ route: '/notes/n1' }));
    await waitForInter(page);

    await page.getByRole('button', { name: 'Export' }).click();

    await expect(page.getByRole('radio', { name: 'Markdown' })).toBeVisible();

    await expect(page).toHaveScreenshot('notes-export-dialog-desktop-1440.png');
  });
});
