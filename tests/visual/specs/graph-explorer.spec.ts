import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ACME_ID, ANA_ID, GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The graph explorer (`/graph/explore`, issue #374, epic #347) and the entity
 * page's Neighbourhood widget, at the three widths every page baseline here
 * uses — phone (390), tablet (820), desktop (1440) — either side of the `sm`
 * (600px) boundary, with 820 the tablet band a `md`-gated layout would wrongly
 * hand the phone treatment to.
 *
 * DETERMINISTIC LAYOUT. Every capture uses `?layout=static`: node positions
 * are the explorer model's own deterministic ring placement and ForceAtlas2
 * never runs, so a baseline cannot depend on how many layout frames happened
 * to run before the capture.
 *
 * WEBGL. Sigma draws with WebGL only. Chromium in the pinned Playwright image
 * has no GPU, so this spec opts into SwiftShader (Chromium's bundled software
 * rasteriser) explicitly — deterministic output on a fixed image, and without
 * it the explorer would (correctly) fall back to its list view and the canvas
 * baselines would never show a canvas.
 *
 * ⚠ These baselines are valid only when generated inside the pinned Playwright
 * image (`.github/workflows/visual-baselines.yml`).
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const PHONE = { width: 390, height: 844 };
const TABLET = { width: 820, height: 1180 };
const LAPTOP = { width: 1180, height: 800 };
const DESKTOP = { width: 1440, height: 900 };

// WIDTHS[0] and WIDTHS[3] are the phone and desktop the other tests in this file use.
const WIDTHS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['laptop-1180', LAPTOP],
  ['desktop-1440', DESKTOP],
] as const;

const THEMES = ['light', 'dark'] as const;

const EXPLORE = `/graph/explore?seed=${JOE_ID}&layout=static`;

async function openExplorer(page: Page, route = EXPLORE, theme: 'light' | 'dark' = 'dark') {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
}

/** The canvas has its slice (the count comes from the same graph the canvas draws). */
async function canvasReady(page: Page, count: number, cap?: number) {
  // A compact window (under 600px) holds the explorer to the phone budget (GIC-08): 120 nodes, not 300.
  cap ??= (page.viewportSize()?.width ?? 1440) < 600 ? 120 : 300;
  await expect(page.getByLabel(`${count} of ${cap} nodes`)).toBeVisible();
  const app = page.getByRole('application', { name: /^Graph explorer/ });
  await expect(app).toBeVisible();
  await expect(app.locator('canvas').first()).toBeVisible();
  // No spinner left over the canvas.
  await expect(page.getByRole('progressbar')).toHaveCount(0);
  return app;
}

test.describe('Graph explorer', () => {
  // #667: the visual language (type colour and pictogram, size, curved parallel
  // edges: Joe to Acme is both WORKS_FOR and HAS_ROLE) at the four widths, in
  // both themes.
  for (const [name, viewport] of WIDTHS) {
    for (const theme of THEMES) {
      test(`explorer @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await openExplorer(page, EXPLORE, theme);
        // Joe plus his five neighbours.
        await canvasReady(page, 6);

        await expect(page).toHaveScreenshot(`graph-explorer-${name}-${theme}.png`);
      });
    }
  }

  test('one node expanded, side panel open @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page);
    const app = await canvasReady(page, 6);

    // Keyboard order is degree then label: Joe, then Acme Corp.
    await app.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('group', { name: 'Acme Corp' })).toBeVisible();
    await page.keyboard.press('Enter');
    // Acme adds Ben Okafor, Dana Li and Project Atlas.
    await canvasReady(page, 9);
    await expect(page.getByRole('button', { name: 'Expand again' })).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-expanded-desktop-1440.png');
  });

  test('side panel as a bottom sheet @ phone-390', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(PHONE);
    await openExplorer(page);
    const app = await canvasReady(page, 6);

    await app.focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('heading', { level: 2, name: 'Joe Rivera' })).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-sheet-phone-390.png');
  });

  test('cap warning @ desktop-1440', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages', explorerCapped: true });
    await page.setViewportSize(DESKTOP);
    await openExplorer(page);
    await canvasReady(page, 300);
    await expect(page.getByText(/Showing 300 nodes — the limit for the explorer/)).toBeVisible();

    await expect(page).toHaveScreenshot('graph-explorer-capped-desktop-1440.png');
  });

  for (const [name, viewport] of [WIDTHS[0], WIDTHS[3]] as const) {
    test(`list view @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await openExplorer(page, `${EXPLORE}&view=list`);

      const list = page.getByRole('region', { name: 'Graph as a list' });
      await expect(list.getByText('Acme Corp')).toBeVisible();
      if (viewport.width < 600) {
        // On a phone the view controls are in the overflow menu.
        await page.getByRole('button', { name: 'More actions' }).click();
        await expect(page.getByRole('menuitem', { name: 'Graph view' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(page.getByRole('menu')).toHaveCount(0);
      } else {
        await expect(page.getByRole('button', { name: 'List view', pressed: true })).toBeVisible();
      }

      await expect(page).toHaveScreenshot(`graph-explorer-list-${name}.png`, { fullPage: true });
    });
  }
});

test.describe('Entity page — Neighbourhood widget', () => {
  for (const [name, viewport] of [WIDTHS[0], WIDTHS[3]] as const) {
    test(`neighbourhood widget @ ${name}`, async ({ page }) => {
      await installGraphApi(page, { surface: 'pages' });
      await page.setViewportSize(viewport);
      await page.goto(
        harnessUrl({ route: `/graph/entities/${JOE_ID}?layout=static`, perms: GRAPH_PERMS }),
      );
      await waitForInter(page);

      await expect(page.getByRole('heading', { level: 1, name: 'Joe Rivera' })).toBeVisible();
      const widget = page.getByRole('region', { name: 'Neighbourhood' });
      await expect(widget.locator('canvas').first()).toBeVisible();
      await expect(widget.getByRole('link', { name: 'Open in explorer' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Works for' })).toBeVisible();

      await expect(widget).toHaveScreenshot(`graph-neighbourhood-${name}.png`);
    });
  }
});

// =============================================================================
// The responsive Insight Canvas shell (GIC-08, #669, epic #661)
//
// Four viewports, light and dark: a phone (390x844), a tablet in portrait
// (820x1180), the SAME tablet in landscape (1180x820, still the `medium`
// window class: 1200 is the first expanded width) and a laptop (1440x900).
//
// The "Start here" state of the epic does not exist yet: the empty state today
// is the seed search, and these baselines capture it. The story that builds
// "Start here" replaces that baseline.
//
// ⚠ Every baseline below is new and must be generated in the pinned Playwright
// image (`.github/workflows/visual-baselines.yml`). The behavioural tests (touch
// emulation, resizers, rotation, budgets) assert and need no baseline.
// =============================================================================

const LAPTOP_LANDSCAPE = { width: 1180, height: 820 };

const SHELL_VIEWPORTS = [
  ['phone-390', PHONE],
  ['tablet-820', TABLET],
  ['tablet-landscape-1180', LAPTOP_LANDSCAPE],
  ['desktop-1440', DESKTOP],
] as const;

const THEMES = ['light', 'dark'] as const;

async function openShell(page: Page, route: string, theme: 'light' | 'dark') {
  await page.goto(harnessUrl({ route, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
}

/**
 * Selects Acme Corp by clicking its node and waits for the inspector. By click, not by keyboard: on a
 * phone the bottom sheet takes focus when it opens (so a second ArrowRight would go to the sheet).
 */
async function selectAcme(page: Page) {
  await cameraSettled(page);
  const at = await nodePoint(page, ACME_ID);
  await page.mouse.click(at.x, at.y);
  await expect(page.getByRole('group', { name: 'Acme Corp' })).toBeVisible();
}

test.describe('Insight Canvas shell — baselines', () => {
  for (const theme of THEMES) {
    for (const [name, viewport] of SHELL_VIEWPORTS) {
      test(`empty state @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages', empty: true });
        await page.setViewportSize(viewport);
        await openShell(page, '/graph/explore?layout=static', theme);
        await expect(page.getByRole('combobox', { name: 'Start from a person, organization or project' })).toBeVisible();

        await expect(page).toHaveScreenshot(`graph-shell-empty-${name}-${theme}.png`);
      });

      test(`ego view with the inspector open @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await openShell(page, EXPLORE, theme);
        await canvasReady(page, 6);
        await selectAcme(page);
        await expect(page.getByRole('region', { name: 'Inspector' })).toBeVisible();
        // The camera pans the selection clear of the overlay or the sheet; let it settle.
        await page.waitForTimeout(400);

        await expect(page).toHaveScreenshot(`graph-shell-ego-${name}-${theme}.png`);
      });

      test(`facets open @ ${name} ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(viewport);
        await openShell(page, EXPLORE, theme);
        await canvasReady(page, 6);

        if (viewport.width < 600) {
          // Compact: a left drawer behind the Filters button.
          await page.getByRole('button', { name: 'Filters' }).click();
          await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
        } else if (viewport.width < 1200) {
          // Medium: the 56px chip rail; a chip opens a popover.
          await page.getByRole('button', { name: 'Filters' }).click();
          await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
        } else {
          // Expanded: the left pane is simply there.
          await expect(page.getByRole('region', { name: 'Filters' })).toBeVisible();
        }
        await expect(page.getByRole('group', { name: 'Filter the graph' })).toBeVisible();
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`graph-shell-facets-${name}-${theme}.png`);
      });
    }

    for (const snap of ['peek', 'half', 'full'] as const) {
      test(`bottom sheet at ${snap} @ phone-390 ${theme}`, async ({ page }) => {
        await installGraphApi(page, { surface: 'pages' });
        await page.setViewportSize(PHONE);
        await openShell(page, EXPLORE, theme);
        await canvasReady(page, 6);
        await selectAcme(page);

        const sheet = page.getByRole(snap === 'full' ? 'dialog' : 'region', { name: 'Inspector' });
        // The handle is a button: arrow up goes up one snap.
        const handle = page.getByRole('button', { name: /^Resize Inspector/ });
        await handle.focus();
        if (snap !== 'peek') await page.keyboard.press('ArrowUp');
        if (snap === 'full') await page.keyboard.press('ArrowUp');
        await expect(sheet).toHaveAttribute('data-snap', snap);
        await page.waitForTimeout(400);

        await expect(page).toHaveScreenshot(`graph-shell-sheet-${snap}-phone-390-${theme}.png`);
      });
    }
  }
});

// -----------------------------------------------------------------------------
// Behaviour: keyboard resizers and persisted widths (expanded)
// -----------------------------------------------------------------------------

test.describe('Insight Canvas shell — panes', () => {
  test('resizers work from the keyboard and the widths survive a reload', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6);
    await selectAcme(page);

    const facets = page.getByRole('separator', { name: 'Resize filters' });
    await expect(facets).toHaveAttribute('aria-valuenow', '280');
    await facets.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(facets).toHaveAttribute('aria-valuenow', '328');

    const inspector = page.getByRole('separator', { name: 'Resize inspector' });
    await inspector.focus();
    await page.keyboard.press('ArrowLeft');
    await expect(inspector).toHaveAttribute('aria-valuenow', '376');

    // The pane really got wider (CSS px), not just the attribute.
    const width = await page.getByRole('region', { name: 'Filters' }).evaluate((el) => el.getBoundingClientRect().width);
    expect(Math.round(width)).toBe(328);

    await page.reload();
    await waitForInter(page);
    await canvasReady(page, 6);
    await expect(page.getByRole('separator', { name: 'Resize filters' })).toHaveAttribute('aria-valuenow', '328');
  });

  test('the keyboard stops at the limits', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await page.setViewportSize(DESKTOP);
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6);
    const facets = page.getByRole('separator', { name: 'Resize filters' });
    await facets.focus();
    await page.keyboard.press('End');
    await expect(facets).toHaveAttribute('aria-valuenow', '400');
    await page.keyboard.press('Home');
    await expect(facets).toHaveAttribute('aria-valuenow', '220');
  });
});

// -----------------------------------------------------------------------------
// Behaviour: touch emulation (`hasTouch`, `isMobile`: a coarse pointer that cannot hover)
// -----------------------------------------------------------------------------

type Point = { x: number; y: number };

async function cdpTouch(page: Page) {
  const session = await page.context().newCDPSession(page);
  const send = (type: 'touchStart' | 'touchMove' | 'touchEnd', at?: Point) =>
    session.send('Input.dispatchTouchEvent', { type, touchPoints: at ? [{ x: at.x, y: at.y }] : [] });
  return {
    session,
    async swipe(from: Point, to: Point, steps = 10) {
      await send('touchStart', from);
      for (let step = 1; step <= steps; step += 1) {
        await send('touchMove', {
          x: from.x + ((to.x - from.x) * step) / steps,
          y: from.y + ((to.y - from.y) * step) / steps,
        });
        await page.waitForTimeout(12);
      }
      await send('touchEnd');
    },
    async hold(at: Point, ms: number) {
      await send('touchStart', at);
      await page.waitForTimeout(ms);
      await send('touchEnd');
    },
  };
}

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

async function camera(page: Page) {
  const container = page.locator('[data-camera-ratio]').first();
  const read = async (name: string) => Number(await container.getAttribute(`data-camera-${name}`));
  return { x: await read('x'), y: await read('y'), ratio: await read('ratio') };
}

/** The camera stops moving (an animation, a pan-into-view). */
async function cameraSettled(page: Page) {
  let previous = await camera(page);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(120);
    const next = await camera(page);
    if (next.x === previous.x && next.y === previous.y && next.ratio === previous.ratio) return next;
    previous = next;
  }
  return previous;
}

// A coarse pointer holds the explorer to the phone budget: 120 nodes, whatever the width.
const TOUCH_CAP = 120;

test.describe('Insight Canvas shell — touch', () => {
  test.use({ viewport: PHONE, hasTouch: true, isMobile: true });

  test('no horizontal page scroll at 390, and only the canvas takes the touch', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);

    const touchAction = await page.evaluate(() => ({
      canvas: getComputedStyle(document.querySelector('[data-camera-ratio]')!.parentElement!.parentElement!).touchAction,
      body: getComputedStyle(document.body).touchAction,
    }));
    expect(touchAction.canvas).toBe('none');
    expect(touchAction.body).not.toBe('none');

    // A swipe across the canvas never moves the page.
    const touch = await cdpTouch(page);
    const box = (await page.locator('[data-camera-ratio]').first().boundingBox())!;
    const scrollBefore = await page.evaluate(() => window.scrollY);
    await touch.swipe({ x: box.x + box.width / 2, y: box.y + box.height * 0.7 }, { x: box.x + box.width / 2, y: box.y + box.height * 0.2 });
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test('first tap highlights, second tap opens the sheet', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    await cameraSettled(page);

    const at = await nodePoint(page, ACME_ID);
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.getByRole('status').filter({ hasText: 'Tap again to open details' })).toContainText('Acme Corp');
    await expect(page.getByRole('region', { name: 'Inspector' })).toHaveCount(0);

    await page.touchscreen.tap(at.x, at.y);
    const sheet = page.getByRole('region', { name: 'Inspector' });
    await expect(sheet).toBeVisible();
    await expect(sheet).toHaveAttribute('data-snap', 'peek');
    await expect(page.getByRole('group', { name: 'Acme Corp' })).toBeVisible();
  });

  test('a long-press opens the context menu', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    await cameraSettled(page);

    const touch = await cdpTouch(page);
    await touch.hold(await nodePoint(page, ANA_ID), 700);
    const menu = page.getByRole('menu', { name: 'Actions for Ana Diaz' });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Pin' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Expand' })).toBeVisible();
    // A long-press is not a tap: nothing opened behind the menu.
    await expect(page.getByRole('region', { name: 'Inspector' })).toHaveCount(0);
  });

  test('the sheet snaps peek, half, full by dragging the handle', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    await cameraSettled(page);

    const at = await nodePoint(page, ACME_ID);
    await page.touchscreen.tap(at.x, at.y);
    await page.touchscreen.tap(at.x, at.y);
    const sheet = page.getByRole('region', { name: 'Inspector' });
    await expect(sheet).toHaveAttribute('data-snap', 'peek');

    const touch = await cdpTouch(page);
    const handle = async () => (await page.getByRole('button', { name: /^Resize Inspector/ }).boundingBox())!;

    let box = await handle();
    await touch.swipe({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y - 220 });
    await expect(page.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', 'half');

    await page.waitForTimeout(350);
    box = await handle();
    await touch.swipe({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y - 300 });
    await expect(page.getByRole('dialog', { name: 'Inspector' })).toHaveAttribute('data-snap', 'full');

    // And down again: a swipe down from full lands on half, then peek.
    await page.waitForTimeout(350);
    box = await handle();
    await touch.swipe({ x: box.x + box.width / 2, y: box.y + box.height / 2 }, { x: box.x + box.width / 2, y: box.y + 260 });
    await expect(page.getByRole('region', { name: 'Inspector' })).toHaveAttribute('data-snap', /half|peek/);
  });

  test('a pinch changes the camera zoom', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    const before = await cameraSettled(page);

    const touch = await cdpTouch(page);
    const box = (await page.locator('[data-camera-ratio]').first().boundingBox())!;
    await touch.session.send('Input.synthesizePinchGesture', {
      x: box.x + box.width / 2,
      y: box.y + box.height / 2,
      scaleFactor: 2,
      relativeSpeed: 400,
      gestureSourceType: 'touch',
    });
    // Zooming in lowers sigma's camera ratio.
    await expect.poll(async () => (await camera(page)).ratio).toBeLessThan(before.ratio);
  });

  test('a coarse pointer holds the graph to 120 nodes and the CapWarning says so', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages', explorerCapped: true });
    await openShell(page, EXPLORE, 'dark');
    await expect(page.getByLabel('120 of 120 nodes')).toBeVisible();
    await expect(page.getByText(/Showing 120 nodes — the limit for the explorer/)).toBeVisible();
    await expect(page.getByText(/Showing 300 nodes/)).toHaveCount(0);
  });

  test('touch shows the Select mode toggle and it marks nodes by tapping', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    await cameraSettled(page);

    await page.getByRole('button', { name: 'Select' }).click();
    await expect(page.getByRole('button', { name: 'Select', pressed: true })).toBeVisible();
    const at = await nodePoint(page, ACME_ID);
    await page.touchscreen.tap(at.x, at.y);
    await expect(page.getByText('1 selected')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Inspector' })).toHaveCount(0);
  });
});

// -----------------------------------------------------------------------------
// Behaviour: rotation keeps the selection and the camera centre
// -----------------------------------------------------------------------------

test.describe('Insight Canvas shell — rotation', () => {
  test.use({ viewport: TABLET, hasTouch: true, isMobile: true });

  test('820x1180 to 1180x820 keeps the selection and the camera centre', async ({ page }) => {
    await installGraphApi(page, { surface: 'pages' });
    await openShell(page, EXPLORE, 'dark');
    await canvasReady(page, 6, TOUCH_CAP);
    // By keyboard: this context is a touch one, where a click is only the first tap (a preview).
    const app = page.getByRole('application', { name: /^Graph explorer/ });
    await app.focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('group', { name: 'Acme Corp' })).toBeVisible();
    const before = await cameraSettled(page);
    const inspectorTitle = page.getByRole('group', { name: 'Acme Corp' });
    await expect(inspectorTitle).toBeVisible();

    await page.setViewportSize(LAPTOP_LANDSCAPE);
    await expect(inspectorTitle).toBeVisible();
    await expect(page.getByLabel('6 of 120 nodes')).toBeVisible();
    const after = await cameraSettled(page);

    // The camera centre is in framed-graph units (0 to 1 across the graph's box): one node radius is
    // about 0.02 of that, and a window resize must not move it by more.
    expect(Math.abs(after.x - before.x)).toBeLessThan(0.02);
    expect(Math.abs(after.y - before.y)).toBeLessThan(0.02);
    expect(after.ratio).toBeCloseTo(before.ratio, 3);
  });
});
