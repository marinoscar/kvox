import { expect, test } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';

/**
 * The ORDINARY rail (i.e. not Console mode) with `Console` pinned at the foot
 * below a divider — the direct regression coverage for bug #105 part 1
 * (`Console` used to render inline as a third destination instead).
 *
 * Two treatments, both on `/` (a non-admin route, so Console mode never
 * engages regardless of width):
 *   - collapsed tier (~767px, below `lg`) — also the direct coverage for bug
 *     #105 part 2 (collapsed captions truncating to "Setti…"/"Cons…"). The
 *     tier widened 56 → 72px in #106 so the 11-character "Transcripts" fits;
 *     the truncation this capture guards against is the same one, one
 *     destination name longer.
 *   - expanded tier (≥ `lg`, 1920px here).
 *
 * Scoped to the `nav` element, not a full-page screenshot: `/`'s body
 * (`HomePage` → `UserProfileCard`) makes its own `/api` calls this harness
 * does not control the timing of (see `main.tsx`'s header comment). The rail
 * itself has no such race — `useNavigationPrefs`' fetch failing resolves to
 * the same `railCollapsed: false` result from the very first render, so its
 * content is stable the instant it paints.
 */

test.describe('Library rail — Console pinned at the foot', () => {
  test('collapsed tier @ 767px (any route)', async ({ page }) => {
    await page.setViewportSize({ width: 767, height: 900 });
    await page.goto(harnessUrl({ route: '/' }));
    // Inter must be in before any pixel is captured - see waitForInter (#111).
    await waitForInter(page);

    const rail = page.locator('nav[aria-label="Main navigation"]');
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Home' })).toBeVisible();
    // Asserted since #30, and since #106 as the TWO rows the one Library row
    // became: the rail is the only surface at this width that shows them, and
    // a baseline alone would not say WHICH row went missing.
    await expect(rail.getByRole('link', { name: 'Transcripts' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Notes' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'User Settings' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Console' })).toBeVisible();

    await expect(rail).toHaveScreenshot('library-rail-767px-collapsed-pinned-console.png');
  });

  test('expanded tier @ lg, non-admin route', async ({ page }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.goto(harnessUrl({ route: '/' }));
    // Inter must be in before any pixel is captured - see waitForInter (#111).
    await waitForInter(page);

    const rail = page.locator('nav[aria-label="Main navigation"]');
    await expect(rail).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Home' })).toBeVisible();
    // Asserted since #30, and since #106 as the TWO rows the one Library row
    // became: the rail is the only surface at this width that shows them, and
    // a baseline alone would not say WHICH row went missing.
    await expect(rail.getByRole('link', { name: 'Transcripts' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Notes' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'User Settings' })).toBeVisible();
    await expect(rail.getByRole('link', { name: 'Console' })).toBeVisible();

    await expect(rail).toHaveScreenshot('library-rail-1920px-expanded-pinned-console.png');
  });
});
