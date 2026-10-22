import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ACME_ID, GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * Lenses, history and the shortcuts dialog of the graph explorer (GIC-17, #678, epic #661) at
 * the four widths the Insight Canvas is accepted at (390, 820, 1180, 1440), light and dark.
 *
 * ⚠ Every baseline below is new and must be generated in the pinned Playwright image
 * (`.github/workflows/visual-baselines.yml`); none is committed with this change. The behavioural
 * tests (no horizontal scroll at 390, touch targets of at least 44px, the phone's full-screen lens
 * list) assert and need no baseline.
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const VIEWPORTS = [
  ['phone-390', { width: 390, height: 844 }],
  ['tablet-820', { width: 820, height: 1180 }],
  ['tablet-landscape-1180', { width: 1180, height: 820 }],
  ['desktop-1440', { width: 1440, height: 900 }],
] as const;
const THEMES = ['light', 'dark'] as const;
const EXPLORE = `/graph/explore?seed=${JOE_ID}&layout=static`;

async function open(page: Page, route: string, theme: 'light' | 'dark') {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  await expect(page.getByRole('application', { name: /^Graph explorer/ })).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
}

/** Where a node is drawn, in page coordinates (the canvas's own probe, see `GraphCanvas`). */
async function clickNode(page: Page, nodeId: string) {
  const container = page.locator('[data-camera-ratio]').first();
  await page.waitForTimeout(500);
  const box = await container.boundingBox();
  if (!box) throw new Error('the canvas has no box');
  const at = await container.evaluate(
    (el, id) => (el as unknown as { kvoxProbe: { nodeViewport(id: string): { x: number; y: number } | null } }).kvoxProbe.nodeViewport(id),
    nodeId,
  );
  if (!at) throw new Error(`node ${nodeId} is not on the canvas`);
  await page.mouse.click(box.x + at.x, box.y + at.y);
}

/** Opens the lens list: a dropdown, or on a phone the full-screen list behind the overflow menu. */
async function openLenses(page: Page) {
  const phone = (page.viewportSize()?.width ?? 1440) < 600;
  if (phone) {
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Lenses' }).click();
  } else {
    await page.getByRole('button', { name: 'Lens' }).click();
  }
  await expect(page.getByRole('dialog', { name: 'Lenses' })).toBeVisible();
}

test.describe('Lenses, history and shortcuts — baselines', () => {
  for (const theme of THEMES) {
    for (const [name, viewport] of VIEWPORTS) {
      test(`lens list @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await open(page, EXPLORE, theme);
        await openLenses(page);
        await expect(page.getByText('Stakeholders & stance')).toBeVisible();

        await expect(page).toHaveScreenshot(`graph-lenses-list-${name}-${theme}.png`);
      });

      test(`keyboard shortcuts @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await open(page, EXPLORE, theme);
        await page.keyboard.press('?');
        await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();

        await expect(page).toHaveScreenshot(`graph-shortcuts-${name}-${theme}.png`);
      });

      test(`focus trail @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await open(page, EXPLORE, theme);
        // Two focus steps, as a user takes them: Acme, then Joe.
        await clickNode(page, ACME_ID);
        await expect(page.getByRole('group', { name: 'Acme Corp' })).toBeVisible();
        await clickNode(page, JOE_ID);
        await expect(page.getByRole('navigation', { name: 'Focus trail' }).or(page.getByLabel(/^Focus: /))).toBeVisible();
        await page.waitForTimeout(400);

        await expect(page).toHaveScreenshot(`graph-focus-trail-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Lenses, history and shortcuts — behaviour', () => {
  test('no horizontal page scroll at 390 with the toolbar, lens list and shortcuts', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, EXPLORE, 'dark');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(await overflow()).toBeLessThanOrEqual(0);

    await openLenses(page);
    expect(await overflow()).toBeLessThanOrEqual(0);
    await page.keyboard.press('Escape');
    await page.keyboard.press('?');
    expect(await overflow()).toBeLessThanOrEqual(0);
  });

  test('the phone lens list is full-screen and its touch targets are at least 44px', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize({ width: 390, height: 844 });
    await open(page, EXPLORE, 'light');
    await openLenses(page);

    const dialog = page.getByRole('dialog', { name: 'Lenses' });
    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(389);
    expect(box?.height).toBeGreaterThanOrEqual(843);
    for (const target of [
      page.getByRole('button', { name: 'Close' }),
      page.getByRole('button', { name: /Save current view as a lens/ }),
    ]) {
      const size = await target.boundingBox();
      expect(size?.height).toBeGreaterThanOrEqual(44);
    }
  });
});
