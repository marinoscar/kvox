import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The explorer TimeBar (GIC-15, #676, epic #661) at the four widths of the
 * Insight Canvas acceptance — phone 390 (the strip collapsed AND expanded),
 * tablet 820, laptop 1180 and desktop 1440 — in light and dark, plus the
 * behaviours that need a real layout: the heights the shell promises, the 44px
 * handles on a touch phone, and keyboard handles that move one bucket.
 *
 * DETERMINISM. The axis ends at "now", so the clock is frozen
 * (`page.clock.setFixedTime`), the activity is a fixed fixture
 * (`support/graphApi.ts`) and the layout is static.
 *
 * ⚠ Every screenshot below is NEW (and the existing explorer baselines gain a
 * time bar): none can be generated outside the pinned Playwright image. Run
 * `.github/workflows/visual-baselines.yml` to create them. The behavioural
 * tests assert and need no baseline.
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const NOW = new Date('2026-06-15T12:00:00Z');
const EXPLORE = `/graph/explore?seed=${JOE_ID}&layout=static`;
const RANGE = '&from=2026-01-01&to=2026-04-01';

const VIEWPORTS = [
  ['phone-390', { width: 390, height: 844 }],
  ['tablet-820', { width: 820, height: 1180 }],
  ['laptop-1180', { width: 1180, height: 820 }],
  ['desktop-1440', { width: 1440, height: 900 }],
] as const;
const THEMES = ['light', 'dark'] as const;

async function openExplorer(page: Page, route: string, theme: 'light' | 'dark') {
  await page.clock.setFixedTime(NOW);
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  const bar = page.getByRole('group', { name: 'Time bar' });
  await expect(bar).toBeVisible();
  // The histogram is drawn once the activity has arrived (compact collapsed: the sparkline strip).
  await expect(bar.locator('svg').first()).toBeVisible();
  await page.waitForTimeout(500);
  return bar;
}

test.describe('TimeBar — baselines', () => {
  for (const theme of THEMES) {
    for (const [name, viewport] of VIEWPORTS) {
      test(`histogram with a brush @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        const bar = await openExplorer(page, `${EXPLORE}${RANGE}`, theme);

        if (viewport.width < 600) {
          // Compact: first the 28px strip, then the strip expanded to 120px with 44px handles.
          await expect(page).toHaveScreenshot(`graph-timebar-strip-${name}-${theme}.png`);
          await page.getByRole('button', { name: 'Expand the time bar' }).click();
          await expect(page.getByRole('slider', { name: 'Range start' })).toBeVisible();
          await page.waitForTimeout(300);
          await expect(page).toHaveScreenshot(`graph-timebar-expanded-${name}-${theme}.png`);
        } else {
          await expect(page.getByRole('slider', { name: 'Range start' })).toBeVisible();
          await expect(bar).toHaveScreenshot(`graph-timebar-${name}-${theme}.png`);
        }
      });
    }
  }
});

test.describe('TimeBar — geometry and input', () => {
  test('heights follow the window class: 28 strip, 120 expanded strip, 96 medium, 112 expanded', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    const height = async () => (await page.getByRole('group', { name: 'Time bar' }).boundingBox())!.height;

    await page.setViewportSize({ width: 390, height: 844 });
    await openExplorer(page, EXPLORE, 'light');
    expect(Math.round(await height())).toBe(28);
    await page.getByRole('button', { name: 'Expand the time bar' }).click();
    await expect.poll(async () => Math.round(await height())).toBe(120);

    await page.setViewportSize({ width: 820, height: 1180 });
    await expect.poll(async () => Math.round(await height())).toBe(96);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(async () => Math.round(await height())).toBe(112);
  });

  test('desktop: arrow keys move a handle one bucket and Shift+arrows a quarter, and the URL follows', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openExplorer(page, `${EXPLORE}${RANGE}`, 'light');

    const end = page.getByRole('slider', { name: 'Range end' });
    await end.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => new URL(page.url()).searchParams.get('to')).toBe('2026-05-01');
    await page.keyboard.press('Shift+ArrowLeft');
    await expect.poll(() => new URL(page.url()).searchParams.get('to')).toBe('2026-02-01');
    expect(new URL(page.url()).searchParams.get('from')).toBe('2026-01-01');
  });

  test('desktop: the Set range sheet is an alternative to dragging', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await openExplorer(page, EXPLORE, 'light');

    await page.getByRole('button', { name: 'Set range' }).click();
    const dialog = page.getByRole('dialog', { name: 'Set the time range' });
    await dialog.getByLabel('From').fill('2025-09-10');
    await dialog.getByLabel('To (included)').fill('2025-10-20');
    await dialog.getByRole('button', { name: 'Apply' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => new URL(page.url()).searchParams.get('from')).toBe('2025-09-01');
    expect(new URL(page.url()).searchParams.get('to')).toBe('2025-11-01');
  });

  test('desktop: wheel zoom narrows the axis to weeks', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize({ width: 1440, height: 900 });
    const bar = await openExplorer(page, EXPLORE, 'light');

    const plot = bar.getByTestId('timebar-plot');
    const box = (await plot.boundingBox())!;
    await page.mouse.move(box.x + box.width - 40, box.y + box.height / 2);
    // Zooming in far enough asks for the activity in weeks.
    const weeks = page.waitForRequest((request) => /\/graph\/activity.*bucket=week/.test(request.url()));
    for (let i = 0; i < 8; i += 1) await page.mouse.wheel(0, -120);
    await weeks;
  });

  test.describe('touch phone', () => {
    test.use({ hasTouch: true, isMobile: true });

    test('the handles are 44px wide and the controls are 44px tall once the strip is expanded', async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize({ width: 390, height: 844 });
      await openExplorer(page, `${EXPLORE}${RANGE}`, 'light');

      // Tapping the sparkline expands it.
      await page.getByRole('button', { name: /^Time bar\./ }).tap();
      const start = page.getByRole('slider', { name: 'Range start' });
      await expect(start).toBeVisible();
      expect(Math.round((await start.boundingBox())!.width)).toBeGreaterThanOrEqual(44);
      for (const name of ['Play', 'Set range']) {
        expect(Math.round((await page.getByRole('button', { name }).boundingBox())!.height)).toBeGreaterThanOrEqual(44);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    });
  });
});
