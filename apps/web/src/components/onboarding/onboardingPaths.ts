/**
 * Where each checklist lives — issues #277, #278 and #279, epic #271.
 *
 * =============================================================================
 * TWO STRINGS, AND THEY ARE DECLARED HERE BECAUSE FOUR PLACES NEED THEM
 * =============================================================================
 *
 * The banner (#277) links to a checklist; the registry card (#278/#279)
 * declares the route that renders it; `App.tsx` routes it; and the dismissal
 * confirmation names it in prose. Four places, one string each, and a typo in
 * any of them is invisible until somebody clicks: `App.tsx`'s `*` catch-all
 * swallows an unrouted path and lands the user on the home page with no
 * explanation, which is the failure `adminSections.tsx`'s own header describes
 * for a card pointing at a page that does not exist.
 *
 * So the banner and the tests import these, and
 * `__tests__/components/onboarding/OnboardingBanner.test.tsx` asserts that the
 * registry card's `path` is the SAME constant rather than a string that merely
 * looks the same today.
 *
 * ⚠ THE REGISTRY CARDS THEMSELVES STILL SPELL THE PATH OUT as a literal, and
 * that is deliberate rather than an oversight. `config/adminSections.tsx` and
 * `config/userSettingsSections.tsx` are declarative data read by three surfaces
 * each; every other card in both files carries a literal `path`, and importing
 * a constant for exactly one of them would make that one card read differently
 * from its dozen siblings for no gain the tests do not already provide.
 *
 * Root-relative, never absolute, and with no query string: `?setup=<stepKey>`
 * is appended by the page that sends a user onward (#278/#279), not baked in
 * here — the two pages are DESTINATIONS, and a destination that carried its own
 * query would arrive at itself pre-filtered.
 */

/** The deployment checklist (#278). Gated on `system_settings:read`. */
export const ADMIN_SETUP_PATH = '/admin/settings/setup';

/** The caller's own checklist (#279). Ungated, like every `/settings/*` route. */
export const GETTING_STARTED_PATH = '/settings/getting-started';

/**
 * The query parameter a step's action appends when it sends the user to the
 * page that satisfies it — `?setup=admin.transcription`.
 *
 * ⚠ SPELLED ONCE, HERE, because #280's return-to-setup bar READS it on the
 * destination page. A writer and a reader of the same parameter under two
 * different spellings is a bar that never appears, with nothing failing
 * anywhere: the link still works, the user still lands, and the only symptom is
 * the absence of a control nobody has seen yet.
 */
export const SETUP_RETURN_PARAM = 'setup';

/**
 * A step's `href` with the return marker appended.
 *
 * Appends to whatever query the registry's `href` already carries rather than
 * replacing it — no step declares one today, but a step that later links to
 * `/admin/settings/users?tab=allowlist` must not have that stripped by the act
 * of being clicked from a checklist.
 */
export function withSetupReturn(href: string, stepKey: string): string {
  const separator = href.includes('?') ? '&' : '?';
  return `${href}${separator}${SETUP_RETURN_PARAM}=${encodeURIComponent(stepKey)}`;
}
