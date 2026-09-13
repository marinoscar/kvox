/**
 * `useVisiblePolling` — an interval that stops with the tab.
 *
 * Introduced by issue #266 for the jobs page and EXTRACTED here by #271, when
 * the worker-fleet page needed the same behaviour. Extracted rather than
 * copied, and the distinction is the whole point of this file existing: two
 * implementations of "poll, but not in a background tab" would be two places
 * the `visibilitychange` teardown could be got subtly wrong, and the second
 * one would be discovered the way the first would have been — by a dashboard
 * left open overnight, months later, in somebody's database load graph.
 *
 * `hooks/useJobs.ts` and `hooks/useWorkerNodes.ts` both RE-EXPORT this so each
 * page keeps importing its polling from the hook module it already depends on
 * (and so a page test that mocks that module still intercepts the poll). The
 * re-exports are aliases of this one function; there is exactly one
 * implementation, and this is it.
 *
 * =============================================================================
 * WHY THE INTERVAL STOPS WITH THE TAB
 * =============================================================================
 *
 * These pages poll because their contents change with nobody touching them: a
 * queue drains, a worker stops heartbeating. An operator watching either needs
 * the numbers to move, and a manual refresh button turns "is it recovering"
 * into a clicking exercise.
 *
 * A bare `setInterval` keeps firing in a background tab, and that is not a
 * micro-optimisation to skip. A dashboard left open on a second monitor
 * overnight is ~2,900 requests at a 10-second poll — each one a real query
 * against the same database the workers are competing for — and every response
 * is discarded, because nobody is looking. Browsers throttle background timers
 * but do not stop them, and the throttling is neither uniform nor something a
 * server capacity plan can rely on.
 *
 * So the interval is torn down on `visibilitychange` to hidden and rebuilt on
 * the way back, with ONE IMMEDIATE FETCH on return. The immediate fetch is the
 * half that makes the pause invisible to the operator: without it, a tab
 * restored after an hour would show hour-old numbers for up to a full interval,
 * which is worse than not pausing at all — stale data that looks live.
 */

import { useEffect, useRef } from 'react';

/**
 * Call `callback` every `intervalMs` — but only while the document is visible.
 *
 * `callback` is held in a ref rather than being an effect dependency: a page
 * naturally passes a fresh closure on every render (it reads the current
 * filters), and depending on it directly would tear down and rebuild the
 * interval on every keystroke, so the timer would never actually reach its
 * period. The ref is updated on each render, so a tick always calls the
 * LATEST closure while the timer itself survives.
 *
 * `intervalMs <= 0` disables polling entirely, which is what a test — or a
 * caller with no reason to poll — passes.
 */
export function useVisiblePolling(callback: () => void, intervalMs: number): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (intervalMs <= 0) return;

    let timer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };

    const start = () => {
      // Guarded rather than assumed: `visibilitychange` can fire more than
      // once for the same effective state, and an unguarded `setInterval`
      // would leak a second timer and double the request rate.
      if (timer !== null) return;
      timer = setInterval(() => callbackRef.current(), intervalMs);
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        stop();
        return;
      }
      // Catch up FIRST, then resume — see the file header on why a resumed
      // poll that waits out a full interval is worse than never pausing.
      callbackRef.current();
      start();
    };

    // A tab that is already hidden at mount never starts one.
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs]);
}
