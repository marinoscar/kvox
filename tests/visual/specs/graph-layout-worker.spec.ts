import { expect, test, type Page } from '@playwright/test';
import { harnessUrl, waitForInter } from '../support/harness';
import { GRAPH_PERMS, JOE_ID, installGraphApi } from '../support/graphApi';

/**
 * The explorer's layout worker (GIC-07, issue #668, epic #661).
 *
 * Functional, not pixel: no screenshot here. It asserts, in a real browser, what
 * jsdom cannot:
 *
 *   1. THE WORKER IS ALLOWED BY `worker-src 'self'`. The page is served with the
 *      production policy's worker directive (`infra/nginx/csp.conf`); no
 *      `securitypolicyviolation` event fires, and the layout worker is a
 *      same-origin URL, never `blob:` (FA2's own `/worker` supervisor builds a
 *      `blob:` URL and would be refused).
 *   2. THE MAIN THREAD IS NOT BLOCKED. A long-task observer runs through a
 *      300-node layout; no task exceeds 50 ms. The measured maximum is attached
 *      to the test as an annotation so a PR can quote it.
 *
 * It runs against the harness dev server, which serves the worker file from the
 * same origin; the production worker directive is injected below, so the browser
 * enforces it. The production BUILD's worker asset (`assets/layout.worker-*.js`,
 * emitted same-origin by `apps/web`'s `vite build`) is checked by the build, not
 * here.
 *
 * Only tasks that START after the worker is created count towards the 50 ms
 * budget: the page's own load and first WebGL frame are not the layout's.
 *
 * ⚠ Chromium in the pinned image has no GPU: SwiftShader, as in the explorer spec.
 */

test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

const DESKTOP = { width: 1440, height: 900 };

/** The worker directive of `infra/nginx/csp.conf`'s `default` policy. */
const PRODUCTION_WORKER_SRC = "worker-src 'self'";

async function watchCsp(page: Page) {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __violations: string[];
      __longTasks: Array<{ start: number; duration: number }>;
      __layoutStart: number | null;
    };
    w.__violations = [];
    w.__longTasks = [];
    w.__layoutStart = null;
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        w.__layoutStart ??= performance.now();
      }
    };
    document.addEventListener('securitypolicyviolation', (event) => {
      w.__violations.push(`${event.violatedDirective} ${event.blockedURI}`);
    });
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          w.__longTasks.push({ start: entry.startTime, duration: entry.duration });
        }
      }).observe({ entryTypes: ['longtask'] });
    } catch {
      // Long-task entries are Chromium-only; the check below then records nothing.
    }
  });
  // Serve the document with the production worker policy, whatever the server is.
  await page.route('**/*', async (route) => {
    if (route.request().resourceType() !== 'document') return route.continue();
    const response = await route.fetch();
    await route.fulfill({
      response,
      headers: { ...response.headers(), 'content-security-policy': PRODUCTION_WORKER_SRC },
    });
  });
}

test.describe('Explorer layout worker', () => {
  test('runs under worker-src self with no CSP violation, off the main thread', async ({ page }) => {
    const workerUrls: string[] = [];
    page.on('worker', (worker) => workerUrls.push(worker.url()));

    await watchCsp(page);
    await installGraphApi(page, { surface: 'pages', explorerCapped: true });
    await page.setViewportSize(DESKTOP);
    await page.goto(
      harnessUrl({ route: `/graph/explore?seed=${JOE_ID}&layout=force`, perms: GRAPH_PERMS }),
    );
    await waitForInter(page);
    await expect(page.getByLabel('300 of 300 nodes')).toBeVisible();

    // The layout starts a worker for the run ...
    await expect.poll(() => workerUrls.length, { timeout: 15_000 }).toBeGreaterThan(0);
    const origin = new URL(page.url()).origin;
    for (const url of workerUrls) {
      expect(url.startsWith('blob:')).toBe(false);
      expect(new URL(url).origin).toBe(origin);
      expect(url).toMatch(/layout\.worker/);
    }

    // ... let it finish (the 3 s time box is the ceiling), then read the evidence.
    await page.waitForTimeout(4_000);
    const { violations, longTasks } = await page.evaluate(() => {
      const w = window as unknown as {
        __violations: string[];
        __longTasks: Array<{ start: number; duration: number }>;
        __layoutStart: number | null;
      };
      const from = w.__layoutStart ?? Infinity;
      return {
        violations: w.__violations,
        longTasks: w.__longTasks.filter((task) => task.start >= from).map((task) => task.duration),
      };
    });

    expect(violations).toEqual([]);
    const longest = longTasks.length ? Math.max(...longTasks) : 0;
    test.info().annotations.push({ type: 'longest-main-thread-task-ms', description: longest.toFixed(1) });
    expect(longest).toBeLessThanOrEqual(50);
  });
});
