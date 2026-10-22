import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ACME_ID, ANA_ID, GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * Multi-select, lasso and "What connects these" in the explorer (GIC-14, #675, epic #661).
 *
 * Baselines at the four widths of the epic (390 / 820 / 1180 / 1440), light and dark, of the results view a
 * notes entry opens (`?connectNotes=`): the shared entity ringed on the canvas and the answer in the
 * inspector (a bottom sheet on a phone, an overlay on a tablet, the pane on a desktop). The behavioural
 * tests drive the gestures: Shift-click and a Shift+drag lasso with a pointer, Select-mode taps with touch
 * (`hasTouch`), and Space on the focused node from the keyboard.
 *
 * ⚠ The baselines (`graph-connect.spec.ts-snapshots/`) are NOT committed with the change that adds this
 * file: they are valid only when generated inside the pinned Playwright image, with
 * `.github/workflows/visual-baselines.yml`.
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const LAPTOP = { width: 1180, height: 800 };
const DESKTOP = { width: 1440, height: 900 };

const WIDTHS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['laptop-1180', LAPTOP],
  ['desktop-1440', DESKTOP],
] as const;
const THEMES = ['light', 'dark'] as const;

const NOTE_A = '00000000-0000-4000-8000-000000000951';
const NOTE_B = '00000000-0000-4000-8000-000000000952';
// `seed` is named so the page does not wait on the stub's seed choice; `layout=static` keeps the capture deterministic.
const CONNECT_NOTES = `/graph/explore?connectNotes=${NOTE_A},${NOTE_B}&seed=${JOE_ID}&layout=static`;
const EXPLORE = `/graph/explore?seed=${JOE_ID}&layout=static`;

async function openExplorer(page: Page, route: string, theme: 'light' | 'dark' = 'dark') {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
}

async function canvasReady(page: Page) {
  const app = page.getByRole('application', { name: /^Graph explorer/ });
  await expect(app).toBeVisible();
  await expect(app.locator('canvas').first()).toBeVisible();
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  return app;
}

type Point = { x: number; y: number };

/** Where a node is drawn, in page coordinates (the canvas's own probe, see `GraphCanvas`). */
async function nodePoint(page: Page, nodeId: string): Promise<Point> {
  const container = page.locator('[data-camera-ratio]').first();
  const box = await container.boundingBox();
  if (!box) throw new Error('the canvas has no box');
  const at = await container.evaluate(
    (el, id) => (el as unknown as { kvoxProbe: { nodeViewport(id: string): Point | null } }).kvoxProbe.nodeViewport(id),
    nodeId,
  );
  if (!at) throw new Error(`node ${nodeId} is not on the canvas`);
  return { x: box.x + at.x, y: box.y + at.y };
}

test.describe('Graph explorer — what connects these', () => {
  for (const [name, viewport] of WIDTHS) {
    for (const theme of THEMES) {
      test(`results @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await openExplorer(page, CONNECT_NOTES, theme);
        await canvasReady(page);
        await expect(page.getByRole('region', { name: 'What connects these' })).toBeVisible();
        await expect(page.getByRole('heading', { name: /in common$/ })).toBeVisible();

        await expect(page).toHaveScreenshot(`graph-connect-${name}-${theme}.png`);
      });
    }
  }

  test('no horizontal page scroll at 390 with the results open', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(PHONE);
    await openExplorer(page, CONNECT_NOTES);
    await canvasReady(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('Shift-click marks nodes and "Find connections" shows what they share @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page, EXPLORE);
    await canvasReady(page);

    const joe = await nodePoint(page, JOE_ID);
    const ana = await nodePoint(page, ANA_ID);
    await page.keyboard.down('Shift');
    await page.mouse.click(joe.x, joe.y);
    await page.mouse.click(ana.x, ana.y);
    await page.keyboard.up('Shift');

    await expect(page.getByText('2 selected')).toBeVisible();
    await page.getByRole('button', { name: 'Find connections' }).click();
    await expect(page.getByRole('heading', { name: '1 organization in common' })).toBeVisible();
  });

  test('Shift+drag draws a lasso around the nodes inside it @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page, EXPLORE);
    await canvasReady(page);

    const points = await Promise.all([JOE_ID, ANA_ID, ACME_ID].map((id) => nodePoint(page, id)));
    const pad = 40;
    const left = Math.min(...points.map((p) => p.x)) - pad;
    const right = Math.max(...points.map((p) => p.x)) + pad;
    const top = Math.min(...points.map((p) => p.y)) - pad;
    const bottom = Math.max(...points.map((p) => p.y)) + pad;

    await page.keyboard.down('Shift');
    await page.mouse.move(left, top);
    await page.mouse.down();
    await page.mouse.move(right, top, { steps: 6 });
    await page.mouse.move(right, bottom, { steps: 6 });
    await page.mouse.move(left, bottom, { steps: 6 });
    await expect(page.getByTestId('lasso-overlay')).toBeVisible();
    await page.mouse.up();
    await page.keyboard.up('Shift');

    await expect(page.getByTestId('lasso-overlay')).toHaveCount(0);
    await expect(page.getByText(/\d+ selected/)).toBeVisible();
    expect(Number((await page.getByText(/\d+ selected/).textContent())?.match(/\d+/)?.[0])).toBeGreaterThanOrEqual(3);
  });

  test('keyboard: Select mode, then Space on the focused node marks it @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page, EXPLORE);
    const app = await canvasReady(page);

    await page.getByRole('button', { name: 'Select' }).click();
    await app.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.getByText('1 selected')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Space');
    await expect(page.getByText('2 selected')).toBeVisible();
    await expect(page.getByRole('group', { name: 'Selection' })).toBeVisible();
  });
});

test.describe('Graph explorer — what connects these, touch', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('Select mode taps build the selection, and the answer opens in the sheet', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openExplorer(page, EXPLORE);
    await canvasReady(page);

    await page.getByRole('button', { name: 'Select' }).click();
    const joe = await nodePoint(page, JOE_ID);
    const ana = await nodePoint(page, ANA_ID);
    await page.touchscreen.tap(joe.x, joe.y);
    await page.touchscreen.tap(ana.x, ana.y);
    await expect(page.getByText('2 selected')).toBeVisible();

    await page.getByRole('button', { name: 'Find connections' }).click();
    const results = page.getByRole('region', { name: 'What connects these' });
    await expect(results).toBeVisible();
    // The touch target of the action is at least 44px.
    const close = await results.getByRole('button', { name: 'Close connections' }).boundingBox();
    expect(close?.height ?? 0).toBeGreaterThanOrEqual(44);
  });
});
