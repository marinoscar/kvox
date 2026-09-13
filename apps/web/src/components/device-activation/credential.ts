/**
 * Interpreting the UNTRUSTED `clientInfo` blob that the activation page shows.
 *
 * Issue #141. The device authorization flow can now mint one of two very
 * different credentials, and WHICH ONE is chosen by the device that started the
 * flow, not by the person approving it:
 *
 *   - `session` — the historical behaviour: a short-lived access JWT plus a
 *     refresh token, roughly a week of life, dies with the session.
 *   - `pat` — a personal access token with a ~90-day life that authenticates
 *     against every ordinary guarded endpoint and stays valid until it expires
 *     or is revoked from Settings -> Access Tokens.
 *
 * Before this module existed the two approvals rendered IDENTICALLY. That is
 * the gap: `POST /auth/device/code` is public, so anyone can start a flow that
 * asks for the 90-day credential, and the user was consenting to something
 * materially different from what the screen described. Everything here exists
 * to make the difference legible without trusting the blob that describes it.
 *
 * THIS IS THE ONLY PLACE `clientInfo` MAY BE INTERPRETED. Call sites take the
 * outputs, never the raw fields.
 */

/** The credential kinds the UI knows how to describe. */
export type DeviceCredentialKind = 'session' | 'pat';

/**
 * The PAT lifetime we tell the user to expect, in days.
 *
 * APPROXIMATE ON PURPOSE. The real number is server-side configuration
 * (`DEVICE_PAT_EXPIRY_DAYS`, defaulting to 90 and clamped to 1..999 by
 * `DeviceAuthService.resolvePatExpiryDays`) and `GET /auth/device/activate`
 * does not return it. So the copy hedges — "about 90 days" — rather than
 * stating a number we cannot actually know, because a confidently wrong
 * lifetime is worse than an admitted approximation: it is the exact detail the
 * user would rely on to decide.
 *
 * FOLLOW-UP: have the activate response carry the resolved expiry (ideally the
 * concrete `expiresAt` the token would get), and then this constant and the
 * hedged wording both go away. Until then, a deployment that overrides
 * `DEVICE_PAT_EXPIRY_DAYS` shows a number that is off — still the right order
 * of magnitude, and still unambiguously "not a browser session", which is the
 * decision this screen actually drives.
 */
export const DEVICE_PAT_APPROX_DAYS = 90;

/**
 * Which credential is this approval about?
 *
 * FAILS TOWARD `session` BY DESIGN, and the asymmetry matters. Saying "session"
 * for something the server will mint as a PAT under-warns by one step; saying
 * "PAT" for an ordinary session cries wolf on the common path and trains people
 * to click through the warning — which destroys its value for the case it
 * exists for. We therefore claim `pat` ONLY on an exact `'pat'` string, which
 * is precisely the condition the API's own `readTokenType()` uses to decide
 * what to mint. The two predicates agreeing character-for-character is what
 * keeps the screen and the behaviour in sync; loosening this one (case-folding,
 * `String(x).includes('pat')`) without loosening that one would put them back
 * out of step, in the direction where the screen lies.
 *
 * The shapes this must survive, all of them real:
 *   - `clientInfo` absent entirely (the API declares the field optional, and
 *     `null` is what a hand-written or restored row carries).
 *   - `tokenType` absent — every row written before #141.
 *   - `tokenType` present but unexpected: a typo'd `'PAT'`, or a probe sending
 *     `'admin'`. The WRITE path rejects those with a 400, but this is a READ of
 *     a JSONB column that is never re-validated, so the value is whatever is
 *     actually in the database. Such a row will mint a session (the API's own
 *     fallback), and describing it as a session is therefore correct, not just
 *     conservative.
 *   - `clientInfo` not an object at all (a string, an array, a number): JSONB
 *     round-trips any of those, and a property read on them must not throw.
 */
export function readCredentialKind(clientInfo: unknown): DeviceCredentialKind {
  if (
    clientInfo === null ||
    typeof clientInfo !== 'object' ||
    Array.isArray(clientInfo)
  ) {
    return 'session';
  }

  return (clientInfo as Record<string, unknown>).tokenType === 'pat'
    ? 'pat'
    : 'session';
}

/**
 * Display bounds for the free-text fields, in characters.
 *
 * A name is a label, not a payload. Without a bound, a 4KB `deviceName` (the
 * request body has no per-field length limit on the way in) pushes the
 * Approve/Deny buttons off a phone screen, or buries the credential warning
 * under a wall of text the attacker wrote — a layout-level way of hiding the
 * one thing this screen exists to show. The user agent gets a longer budget
 * because real ones are genuinely long, and truncating a legitimate UA to 64
 * characters would hurt recognition, which is the entire reason it is shown.
 */
export const DEVICE_NAME_MAX_DISPLAY = 64;
export const USER_AGENT_MAX_DISPLAY = 180;
export const IP_ADDRESS_MAX_DISPLAY = 64;

/**
 * Turn one untrusted `clientInfo` string into something safe to render.
 *
 * React escapes text nodes, so this is NOT about script injection — that is
 * already handled, and nothing on this page uses `dangerouslySetInnerHTML` or
 * interpolates these values into an attribute, a `style`, an `href` or a key.
 * This is about the attacks that survive escaping, all of which end with the
 * user misreading the screen:
 *
 *   - Bidi overrides (U+202E and friends) and zero-width characters let the
 *     rendered string differ from the stored one. A device that displays as
 *     "Oscar's laptop" while the token it mints is named something else is
 *     exactly how someone is talked into approving the wrong thing.
 *   - Control characters and newline runs let a name draw its own fake UI:
 *     blank space, then a line that reads like the application's own copy
 *     ("Verified device", "Session only") sitting inside our card.
 *   - Unbounded length, per the constants above.
 *
 * Deliberately mirrors the sanitisation `DeviceAuthService.buildPatName()`
 * applies to the token NAME. Same input, same threat — and if the two
 * disagreed, the user would approve one string and later see a different one in
 * the Access Tokens list, leaving them unable to tell which row to revoke. The
 * revocability of a PAT is the thing that makes approving one reasonable, so
 * anything that blurs which row to revoke takes that back.
 *
 * Returns `null` (not `''`) when nothing is left to show, so callers drop the
 * whole labelled row instead of rendering a label over empty space.
 */
export function sanitizeDeviceText(
  raw: unknown,
  maxLength: number,
): string | null {
  // JSONB happily stores objects, numbers and null under these keys; `.trim()`
  // on any of them throws and takes the whole activation page down with it.
  if (typeof raw !== 'string') return null;

  const cleaned = raw
    // NFKC first, so fullwidth and other compatibility disguises of the
    // characters stripped below cannot survive by wearing a different codepoint.
    .normalize('NFKC')
    // C0 controls, DEL and C1 controls -> space. Replaced rather than deleted:
    // deleting would splice the text on either side into a single word.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // Zero-width and bidirectional formatting characters: invisible on screen,
    // so their only purpose is to make stored and displayed text disagree.
    .replace(/[\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, '')
    // Collapse the runs the two substitutions above just created.
    .replace(/\s+/g, ' ')
    .trim();

  if (cleaned.length === 0) return null;

  if (cleaned.length > maxLength) {
    // One character reserved for the ellipsis, so the result lands ON the
    // budget rather than one over it.
    return `${cleaned.slice(0, maxLength - 1)}…`;
  }

  return cleaned;
}
