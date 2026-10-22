import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { ACME_ID, ANA_ID, GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * Path mode of the graph explorer, "Connect A and B" (GIC-13, #674, epic #661):
 * the results at the four widths (390, 820, 1180, 1440), light and dark, plus
 * the behaviour that only a browser can show (the strip's orientation, the
 * phone's full-screen picker, the shareable URL).
 *
 * The paths API is answered here, on top of `installGraphApi`'s explorer
 * fixture, with the same ids, so no shared fixture file changes:
 *
 *   Path 1 (strong):   Joe --WORKS_FOR--> Acme Corp
 *   Path 2 (moderate): Joe --REPORTS_TO--> Ana --WORKS_FOR--> Acme Corp
 *
 * Every date is fixed (a pixel baseline cannot hold "3 minutes ago").
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
const NOTE_ID = id(950);
const FIXED_ISO = '2024-03-01T09:00:00.000Z';
const EDGE_JOE_ACME = id(410);
const EDGE_JOE_ANA = id(411);
const EDGE_ANA_ACME = id(590);

const node = (nodeId: string, type: string, label: string, depth: number) => ({
  id: nodeId,
  nodeKind: 'entity',
  type,
  label,
  depth,
  degree: 3,
  status: null,
  occurredAt: null,
});

const PATHS = {
  from: JOE_ID,
  to: ACME_ID,
  asOf: null,
  paths: [
    { nodeIds: [JOE_ID, ACME_ID], edgeIds: [EDGE_JOE_ACME], hops: 1, score: 1.9 },
    { nodeIds: [JOE_ID, ANA_ID, ACME_ID], edgeIds: [EDGE_JOE_ANA, EDGE_ANA_ACME], hops: 2, score: 1.0 },
  ],
  slice: {
    seedIds: [JOE_ID, ACME_ID],
    asOf: FIXED_ISO,
    nodes: [node(JOE_ID, 'Person', 'Joe Rivera', 0), node(ANA_ID, 'Person', 'Ana Diaz', 1), node(ACME_ID, 'Organization', 'Acme Corp', 0)],
    edges: [
      { id: EDGE_JOE_ACME, type: 'WORKS_FOR', source: JOE_ID, target: ACME_ID, valid: null, confidence: 0.9, virtual: false, props: {}, evidenceCount: 6 },
      { id: EDGE_JOE_ANA, type: 'REPORTS_TO', source: JOE_ID, target: ANA_ID, valid: null, confidence: 0.9, virtual: false, props: {}, evidenceCount: 2 },
      { id: EDGE_ANA_ACME, type: 'WORKS_FOR', source: ANA_ID, target: ACME_ID, valid: null, confidence: 0.9, virtual: false, props: {}, evidenceCount: 1 },
    ],
    truncated: false,
    cap: 300,
  },
  truncated: false,
};

const quote = (n: number, subjectId: string, text: string) => ({
  id: id(n),
  subjectKind: 'relation',
  subjectId,
  quote: text,
  createdAt: FIXED_ISO,
  source: {
    kind: 'note',
    noteId: NOTE_ID,
    noteTitle: 'Org changes — Q3',
    noteVersion: 2,
    currentNoteVersion: 2,
    charStart: 4,
    charEnd: 48,
    versionChanged: false,
    available: true,
    href: `/notes/${NOTE_ID}?v=2`,
  },
});

const QUOTES = [
  quote(731, EDGE_JOE_ACME, 'Joe works for Acme Corp and leads the platform group there.'),
  quote(732, EDGE_JOE_ANA, 'Joe now reports to Ana, starting next month.'),
  quote(733, EDGE_ANA_ACME, 'Ana is a director at Acme Corp.'),
];

async function installPaths(page: Page) {
  await installGraphApi(page, { surface: 'pages' });
  // Registered last, so it answers first.
  await page.route('**/api/graph/**', async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^.*\/api/, '');
    const reply = (data: unknown) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data }) });
    if (path === '/graph/paths') return reply(PATHS);
    if (path === '/graph/evidence/by-subject') {
      const subject = url.searchParams.get('id');
      const items = QUOTES.filter((ev) => ev.subjectId === subject);
      if (items.length > 0) return reply({ items });
    }
    return route.fallback();
  });
}

const ROUTE = `/graph/explore?seed=${JOE_ID}&layout=static&pathFrom=${JOE_ID}&pathTo=${ACME_ID}`;

async function openPaths(page: Page, theme: 'light' | 'dark') {
  await page.goto(harnessUrl({ route: ROUTE, perms: GRAPH_PERMS, theme }));
  await waitForInter(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Explore' })).toBeVisible();
  const strip = page.getByRole('list', { name: /^Path 1, strong evidence/ });
  await expect(strip).toBeVisible();
  // Every hop has its quote before the picture is taken.
  await expect(page.getByText('Joe works for Acme Corp and leads the platform group there.')).toBeVisible();
  return strip;
}

test.describe('Path mode — baselines', () => {
  for (const theme of THEMES) {
    for (const [name, viewport] of VIEWPORTS) {
      test(`path strip @ ${name} ${theme}`, async ({ page }) => {
        await installPaths(page);
        await page.setViewportSize(viewport);
        const strip = await openPaths(page, theme);
        // A phone reads the strip top to bottom inside the sheet; everything wider reads it sideways.
        await expect(strip).toHaveAttribute('data-orientation', viewport.width < 600 ? 'vertical' : 'horizontal');
        await page.waitForTimeout(300);

        await expect(page).toHaveScreenshot(`graph-paths-${name}-${theme}.png`);
      });
    }
  }
});

test.describe('Path mode — behaviour', () => {
  test('"Show on canvas" lights the path and a phone folds the sheet away', async ({ page }) => {
    await installPaths(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openPaths(page, 'light');

    await page.getByRole('button', { name: 'Show on canvas' }).click();
    await expect(page.getByRole('list', { name: /^Path 1/ })).toBeHidden();
    // The top bar's button brings the sheet back.
    await page.getByRole('button', { name: 'Show the connection' }).click();
    await expect(page.getByRole('list', { name: /^Path 1/ })).toBeVisible();
  });

  test('a link with only pathFrom opens a full-screen picker on a phone', async ({ page }) => {
    await installPaths(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(harnessUrl({ route: `/graph/explore?seed=${JOE_ID}&layout=static&pathFrom=${JOE_ID}`, perms: GRAPH_PERMS, theme: 'light' }));
    await waitForInter(page);

    const dialog = page.getByRole('dialog', { name: 'Connect two things' });
    await expect(dialog).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(389);
    expect(box?.height).toBeGreaterThanOrEqual(843);
  });

  test('Enter on a hop opens the edge in the inspector', async ({ page }) => {
    await installPaths(page);
    await page.setViewportSize({ width: 1440, height: 900 });
    const strip = await openPaths(page, 'light');

    await strip.getByRole('button', { name: /Open this connection in the inspector/ }).first().focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`sel=e%3A${EDGE_JOE_ACME}|sel=e:${EDGE_JOE_ACME}`));
    await expect(page.getByRole('tab', { name: 'Evidence', selected: true })).toBeVisible();
  });

  test('no horizontal page scroll at 390', async ({ page }) => {
    await installPaths(page);
    await page.setViewportSize({ width: 390, height: 844 });
    await openPaths(page, 'dark');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  });
});
