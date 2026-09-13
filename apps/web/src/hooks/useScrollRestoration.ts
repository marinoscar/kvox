import { useEffect } from 'react';

/**
 * How long to keep retrying a restore before giving up, in ms.
 *
 * Sized to cover a settings page's first data round-trip on a slow connection
 * without being long enough to fight a user who has already started reading.
 * Past it we stop rather than poll forever — see `attempt()` below.
 */
const RESTORE_DEADLINE_MS = 1000;

/**
 * Namespace for the `sessionStorage` keys this hook owns.
 *
 * Prefixed rather than bare so a surface key like `'settings-hub'` can never
 * collide with anything else the app (or a browser extension) puts in the
 * tab's storage.
 */
const STORAGE_PREFIX = 'eab:scroll:';

/**
 * Restore the document's scroll position when a list-like page is returned to.
 *
 * Issue #91, epic #90. Below `sm` the settings hub becomes an iOS-style
 * drill-down list, and drill-down lives or dies on this detail: returning from
 * a detail page to a long hub and landing back at the top — forcing the user
 * to re-find their place every single time — is exactly what makes a
 * drill-down feel like a broken web page rather than a native settings app.
 * Both hubs (#93 admin, #96 user) call this, so it is written as a generic
 * hook rather than folded into either page.
 *
 * Three facts about this app decide the implementation:
 *
 *  1. **The scroller is the DOCUMENT.** `Layout.tsx`'s shell sets
 *     `minHeight: 100dvh` and `<main>` is not an overflow container — the whole
 *     page scrolls — so the offset lives in `window.scrollY`, not in some
 *     element's `scrollTop`. If a future layout ever makes `<main>` scroll,
 *     this hook silently saves 0 forever and must be revisited with it.
 *  2. **The page fully unmounts** on drill-down, so the offset cannot live in
 *     component state, a ref, or a context — all three die with the tree.
 *     `sessionStorage` outlives the remount (and a reload) while staying
 *     scoped to the tab, which is the right lifetime for a scroll offset:
 *     `localStorage` would restore a position from a session last week.
 *  3. **Content renders asynchronously.** At mount the document is usually far
 *     shorter than the saved offset, so a single `scrollTo` silently CLAMPS to
 *     the current bottom and the user lands somewhere arbitrary. This is why
 *     SPAs get restoration wrong by default, and why
 *     `history.scrollRestoration` does not help: the browser cannot know the
 *     eventual height of content that has not been fetched yet. The only fix
 *     is to retry until the target is actually reachable.
 *
 * @param key      Stable identifier for the scrolled surface, e.g.
 *                 `'admin-settings-hub'`. Namespaced into the storage key so
 *                 two surfaces never share an offset.
 * @param options  `enabled` (default `true`); `false` makes the hook a no-op,
 *                 for a page that should only restore in one of its modes —
 *                 e.g. a hub that restores in its compact drill-down treatment
 *                 but not in the card grid. The hook is still CALLED
 *                 unconditionally, per the rules of hooks; the flag is read
 *                 inside the effect.
 */
export function useScrollRestoration(
  key: string,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options;

  useEffect(() => {
    // Disabled, or an SSR / DOM-less environment: nothing to save or restore.
    if (!enabled || typeof window === 'undefined') return;

    const storageKey = `${STORAGE_PREFIX}${key}`;

    // EVERY touch of `sessionStorage` is wrapped, reads included. Safari in
    // private mode throws on any access, not just on writes, and a throwing
    // read here would take down the whole page on mount. A failure degrades to
    // "no restoration" — a nicety lost, never a crash.
    const read = (): number => {
      try {
        const raw = window.sessionStorage.getItem(storageKey);
        if (raw === null) return 0;
        const parsed = Number.parseInt(raw, 10);
        // Guard the parse as well as the access: a hand-edited or
        // half-written value must not turn into `scrollTo({ top: NaN })`.
        return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      } catch {
        return 0;
      }
    };

    const write = (value: number): void => {
      try {
        window.sessionStorage.setItem(storageKey, String(Math.round(value)));
      } catch {
        /* storage unavailable — restoration is a nicety, not a requirement */
      }
    };

    let cancelled = false;
    let saveFrame: number | null = null;
    let restoreFrame: number | null = null;
    // True only across the handful of frames spanning our OWN programmatic
    // scroll, so the scroll event it provokes is not mistaken for a user
    // gesture and does not abort the restore that just succeeded.
    let selfScrolling = false;

    const abortRestore = () => {
      if (restoreFrame !== null) {
        window.cancelAnimationFrame(restoreFrame);
        restoreFrame = null;
      }
    };

    // --- Save -------------------------------------------------------------
    // Coalesced through rAF: a single scroll gesture fires dozens of events per
    // second, and a synchronous `setItem` on each is a measurable jank source
    // on a phone. One write per painted frame is both sufficient and cheap.
    const handleScroll = () => {
      if (selfScrolling) return;
      // A genuine gesture WINS OUTRIGHT. Restoration must never fight the user
      // for control of the viewport: once they have scrolled, wherever they
      // are is the truth, and any pending restore is stale by definition.
      abortRestore();
      if (saveFrame !== null) return;
      saveFrame = window.requestAnimationFrame(() => {
        saveFrame = null;
        write(window.scrollY);
      });
    };

    window.addEventListener('scroll', handleScroll, { passive: true });

    // --- Restore ----------------------------------------------------------
    const target = read();
    if (target > 0) {
      const deadline = Date.now() + RESTORE_DEADLINE_MS;

      const attempt = () => {
        restoreFrame = null;
        // `cancelled` covers the race the cancelAnimationFrame above cannot:
        // an already-scheduled frame that fires after unmount.
        if (cancelled) return;

        const maxScroll = document.documentElement.scrollHeight - window.innerHeight;

        if (maxScroll >= target) {
          // The document is finally tall enough to honour the saved offset.
          //
          // ALWAYS instant. `behavior: 'smooth'` here would animate the page
          // back to a position the user was already at, which reads as the
          // content sliding out from under them, and the animation's own
          // scroll events would collide with the gesture guard above for its
          // whole duration. Epic #90's accessibility notes require this too:
          // the restore is instant, never smooth, at every reduced-motion
          // setting.
          selfScrolling = true;
          window.scrollTo({ top: target, behavior: 'auto' });
          // Release the guard once the resulting scroll event has been
          // dispatched. Two frames is comfortably past it, and the worst case
          // of being wrong is one skipped save — restoration is already done.
          window.requestAnimationFrame(() => {
            window.requestAnimationFrame(() => {
              selfScrolling = false;
            });
          });
          return;
        }

        // Still too short — content is presumably mid-fetch or mid-render.
        // Retry next frame, but only until the deadline: past it the page is
        // most likely GENUINELY shorter than it was (a card removed, a search
        // filter still applied), and continuing to poll would burn a frame
        // callback forever on a page that will never grow.
        if (Date.now() >= deadline) return;
        restoreFrame = window.requestAnimationFrame(attempt);
      };

      restoreFrame = window.requestAnimationFrame(attempt);
    }

    return () => {
      cancelled = true;
      abortRestore();
      window.removeEventListener('scroll', handleScroll);
      if (saveFrame !== null) {
        window.cancelAnimationFrame(saveFrame);
        saveFrame = null;
      }
      // The pending rAF write (if any) was just cancelled, and a navigation can
      // unmount the page between the last scroll event and the frame that
      // would have written it — so take one FINAL reading here rather than
      // losing up to a frame's worth of movement, which on a fast flick is the
      // difference between restoring the right screenful and the previous one.
      write(window.scrollY);
    };
  }, [key, enabled]);
}
