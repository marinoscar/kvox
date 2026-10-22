import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ACME_ID, ANA_ID, GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The Insights panel of the graph explorer (GIC-16, #677, epic #661): Themes,
 * Connectors, Rising, Fading ties and Open risks, at the four widths (390, 820,
 * 1180, 1440), light and dark.
 *
 *   390   the panel in the left drawer behind the Filters button
 *   820   the panel in the popover of the filter rail
 *   1180, 1440   the panel in the left pane, under the filters and the legend
 *
 * `GET /api/graph/insights` is answered here, on top of `installGraphApi`'s
 * explorer fixture, with the same ids and fixed dates (a pixel baseline cannot
 * hold "3 days ago").
 *
 * ⚠ The PNG baselines are NOT committed from a local run. They are valid only
 * when generated inside the pinned Playwright image
 * (`.github/workflows/visual-baselines.yml`); until then the screenshot
 * assertions create them on first run in that workflow.
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const VIEWPORTS = [
  ['phone-390', { width: 390, height: 844 }],
  ['tablet-820', { width: 820, height: 1180 }],
  ['laptop-1180', { width: 1180, height: 820 }],
  ['desktop-1440', { width: 1440, height: 900 }],
] as const;
const THEMES = ['light', 'dark'] as const;

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const RISK_ID = id(990);
const joe = { id: JOE_ID, label: 'Joe Rivera', type: 'Person' };
const ana = { id: ANA_ID, label: 'Ana Diaz', type: 'Person' };

const INSIGHTS = {
  window: { key: '30d', days: 30, from: '2024-02-01T00:00:00.000Z', previousFrom: '2024-01-02T00:00:00.000Z' },
  status: 'ready',
  pending: false,
  computedAt: '2024-03-01T09:00:00.000Z',
  stale: false,
  tooLarge: false,
  connectorsReady: true,
  themes: [
    { clusterId: 0, label: 'Acme Corp', labelEntityId: ACME_ID, size: 12, typeCounts: { Person: 7, Organization: 2, Project: 3 }, memberSample: [{ ...joe, degree: 5 }] },
    { clusterId: 1, label: 'Globex', labelEntityId: null, size: 7, typeCounts: { Person: 4, Organization: 3 }, memberSample: [{ ...ana, degree: 3 }] },
  ],
  connectors: [
    {
      entity: joe,
      score: 0.42,
      clusters: [
        { id: 0, label: 'Acme Corp' },
        { id: 1, label: 'Globex' },
      ],
      reason: 'Joe Rivera connects the Acme Corp group and the Globex group.',
    },
  ],
  rising: [{ entity: ana, count: 5, previous: 1, reason: 'Came up in 5 conversations in the last 30 days, up from 1 before.' }],
  fadingTies: [
    {
      from: joe,
      to: ana,
      relationTypes: ['KNOWS'],
      lastEvidenceAt: '2023-11-02T00:00:00.000Z',
      evidenceBefore: 4,
      reason: "You haven't discussed Joe Rivera with Ana Diaz since Nov 2, 2023.",
    },
  ],
  openRisks: [
    {
      id: RISK_ID,
      title: 'Legal review',
      statement: 'Legal has not signed off',
      severity: 'high',
      subject: { id: ACME_ID, label: 'Acme Corp', type: 'Organization' },
      occurredAt: '2024-02-20T00:00:00.000Z',
    },
  ],
};

async function installInsights(page: Page) {
  await installGraphApi(page, { surface: 'pages' });
  // Registered last, so it answers first.
  await page.route('**/api/graph/insights**', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: INSIGHTS }) }),
  );
}

/** Opens the explorer and brings the panel into view the way this width reaches it. */
async function openInsights(page: Page, width: number, theme: 'light' | 'dark') {
  await page.goto(harnessUrl({ route: `/graph/explore?seed=${JOE_ID}&layout=static`, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  if (width < 1200) {
    // Compact: the drawer behind the Filters button; medium: the popover of the filter rail.
    await page.getByRole('button', { name: 'Filters' }).click();
    await expect(page.getByRole('dialog', { name: 'Filters' })).toBeVisible();
  }
  const panel = page.getByRole('region', { name: 'Insights' });
  await expect(panel).toBeVisible();
  await expect(panel.getByText('Joe Rivera connects the Acme Corp group and the Globex group.')).toBeVisible();
  return panel;
}

test.describe('Insights panel — baselines', () => {
  for (const theme of THEMES) {
    for (const [name, viewport] of VIEWPORTS) {
      test(`insights @ ${name} ${theme}`, async ({ page }) => {
        await installInsights(page);
        await page.setViewportSize(viewport);
        await openInsights(page, viewport.width, theme);
        await expect(page).toHaveScreenshot(`graph-insights-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Insights panel — behaviour', () => {
  test('a connector seeds the canvas with both groups @ desktop-1440', async ({ page }) => {
    await installInsights(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const panel = await openInsights(page, 1440, 'dark');
    await panel.getByRole('button', { name: /Joe Rivera/ }).first().click();
    await expect(page.getByRole('application', { name: /^Graph explorer/ })).toBeVisible();
  });

  test('no horizontal page scroll @ phone-390', async ({ page }) => {
    await installInsights(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openInsights(page, 390, 'light');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });

  test('every target is at least 44px on a coarse pointer @ phone-390', async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    const page = await context.newPage();
    await installInsights(page);
    const panel = await openInsights(page, 390, 'light');
    const heights = await panel.getByRole('button').evaluateAll((els) => els.map((el) => el.getBoundingClientRect().height));
    expect(heights.length).toBeGreaterThan(5);
    for (const h of heights) expect(h).toBeGreaterThanOrEqual(44);
    await context.close();
  });
});
