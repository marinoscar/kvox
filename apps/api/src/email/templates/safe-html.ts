// =============================================================================
// Safe HTML — escaping as the default path (issue #123, epic #109)
// =============================================================================
//
// Email templates interpolate USER-CONTROLLED DATA into a document that is
// then delivered to somebody else's inbox: display names chosen by the user,
// email addresses, role labels, allowlist entries. Unescaped, that is HTML
// injection with a delivery mechanism attached — and unlike an injection into
// our own web app, the payload lands somewhere we do not control, cannot patch,
// and cannot even observe.
//
// -----------------------------------------------------------------------------
// THE MECHANISM, AND WHY IT IS A TAGGED TEMPLATE RATHER THAN A FUNCTION
// -----------------------------------------------------------------------------
//
// #123 lists the options; this file is the one it recommends. The rule that
// matters is not "escape user data" — everybody agrees with that — it is
// WHICH ACTION IS THE ONE YOU GET BY DEFAULT.
//
// 1. **CHOSEN — a tagged template literal.** `html`<p>${name}</p>`` escapes
//    every interpolation on the way in. Writing the template naturally is
//    writing it safely; the author does not have to remember anything, and
//    there is no per-interpolation decision to get wrong on the day the file
//    is edited in a hurry. Emitting raw markup requires reaching for
//    `SafeHtml.unsafeFromTrustedString`, which is longer to type, contains the
//    word `unsafe`, and greps out of the tree in one command. The unsafe path
//    is the one that costs effort — that is the whole design.
//
// 2. **REJECTED — `escapeHtml()` at every call site, enforced by review.**
//    This is the status quo the reference implementation uses, and its failure
//    mode is silent: a missing call produces working, correct-looking output
//    for every name that contains no angle bracket, which is essentially all
//    of them in development. The bug ships and is discovered by whoever sends
//    themselves a display name of `<script>`. #123 makes the same point about
//    #115's no-plaintext-egress rule: a rule enforced by structure holds, a
//    rule enforced by review holds until someone is busy.
//
// 3. **REJECTED — sanitising the finished HTML document.** Wrong layer and
//    wrong direction. A sanitiser has to guess which markup was intended by
//    the template and which arrived in a display name; it cannot, because by
//    then they are the same string. Escaping at interpolation time is the only
//    point where that distinction still exists.
//
// -----------------------------------------------------------------------------
// HOW THE TYPE SYSTEM CARRIES THE GUARANTEE
// -----------------------------------------------------------------------------
//
// `SafeHtml` is a NOMINAL type: a class with a private field and a private
// constructor. A plain `string` is not assignable to it, an object literal
// shaped like it is not assignable to it, and it cannot be constructed from
// outside this file except through the two named factories below. That is what
// lets `renderLayout({ bodyHtml })` (layout.ts) take `SafeHtml` rather than
// `string` — a body assembled by string concatenation does not typecheck, so
// the compiler, not a reviewer, is what stops it.
//
// Fragments compose: interpolating a `SafeHtml` into another `html` template
// inserts it verbatim rather than double-escaping it, so conditional blocks
// and lists are built the obvious way.
// =============================================================================

/**
 * HTML-escape a string for interpolation into email HTML.
 *
 * Prefer the {@link html} tag, which calls this for you. This is exported
 * because #123 names it in the template contract and because it is
 * occasionally needed on its own — building an attribute value inside a
 * fragment that is already `SafeHtml`, for instance.
 *
 * `&` MUST BE REPLACED FIRST. Escaping it after `<` would turn the `&lt;` this
 * function had just produced into `&amp;lt;`, which renders as the literal
 * text `&lt;` in the recipient's client.
 *
 * The apostrophe is escaped as the numeric `&#39;` rather than `&apos;`: the
 * named form is HTML5-only, and some mail clients still parse bodies with
 * HTML4/XHTML rules where it is undefined.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * A fragment of markup that is known to be safe to emit verbatim.
 *
 * NOT AN INTERFACE, AND NOT A BRANDED STRING ALIAS, deliberately. The private
 * `value` field makes this nominally typed: TypeScript's structural assignment
 * cannot produce one from a `string` or from an object literal, so the only
 * ways to obtain a `SafeHtml` are the {@link html} tag (which escapes) and
 * {@link SafeHtml.unsafeFromTrustedString} (which does not, and says so).
 *
 * The constructor is private so that `new SafeHtml(userInput)` is not a third,
 * unnamed escape hatch sitting next to the two documented ones.
 */
export class SafeHtml {
  private constructor(private readonly value: string) {}

  /**
   * Wrap a string that is ALREADY safe markup, emitting it with no escaping.
   *
   * THIS IS THE ESCAPE HATCH, and it is verbose on purpose — the argument in
   * the header block is that the unsafe action should cost more keystrokes
   * than the safe one, and be greppable in a security review
   * (`grep -rn unsafeFromTrustedString`).
   *
   * The ONLY acceptable argument is markup that is literal in the source, or
   * built entirely from literals. If any part of the string came from the
   * database, a request body, an OAuth profile, or a settings blob, this call
   * is a vulnerability — use the {@link html} tag instead, which handles the
   * composition case natively by interpolating `SafeHtml` fragments verbatim.
   */
  static unsafeFromTrustedString(trusted: string): SafeHtml {
    return new SafeHtml(trusted);
  }

  /**
   * The empty fragment.
   *
   * Exists so a conditional block reads `cond ? html`...` : SafeHtml.EMPTY`
   * rather than tempting the author into `cond ? html`...` : ''`, which would
   * not typecheck, or into typing the whole body as `string`, which would
   * defeat the mechanism.
   */
  static readonly EMPTY: SafeHtml = new SafeHtml('');

  /** The underlying markup. */
  toString(): string {
    return this.value;
  }
}

/**
 * Coerce one interpolated value to markup.
 *
 * `null` and `undefined` render as nothing rather than as the strings "null"
 * and "undefined". Mailing a recipient the word "undefined" is a worse outcome
 * than a missing clause, and optional template data is common enough
 * (`inviterName`, `triggeredBy`) that the alternative would push a `?? ''`
 * onto every such interpolation — another thing to remember, which is the
 * habit this module exists to remove.
 *
 * Arrays are flattened and concatenated with no separator, so a list of
 * `SafeHtml` rows interpolates as a block without a join at the call site.
 */
function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof SafeHtml) return value.toString();
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escapeHtml(String(value));
}

/**
 * Tagged template literal that escapes every interpolation.
 *
 * ```ts
 * const body = html`<p>Hello, ${user.displayName}.</p>${optionalBlock}`;
 * ```
 *
 * `user.displayName` is escaped; `optionalBlock`, being `SafeHtml`, is emitted
 * verbatim. That asymmetry is the entire contract: values are data, fragments
 * are markup, and the type decides which without the author choosing.
 *
 * NOTE THE ONE THING THIS DOES NOT DO: it escapes for HTML, and HTML escaping
 * is not sufficient inside a `javascript:` URL or a `<style>`/`<script>` body.
 * Email templates contain neither — layout.ts explains why there is no
 * `<style>` block — and URLs go through {@link safeUrl}, which rejects every
 * scheme that could carry code.
 */
export function html(
  strings: TemplateStringsArray,
  ...values: unknown[]
): SafeHtml {
  let out = strings[0] ?? '';
  for (let i = 0; i < values.length; i++) {
    out += renderValue(values[i]) + (strings[i + 1] ?? '');
  }
  return SafeHtml.unsafeFromTrustedString(out);
}

/**
 * Schemes a link in an email may use.
 *
 * An allowlist, not a denylist of `javascript:`/`data:`: the set of URL
 * schemes is open-ended and a denylist is one obscure scheme away from being
 * wrong, whereas the set of schemes a transactional email legitimately needs
 * is these three and has been for decades.
 */
const ALLOWED_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:']);

/**
 * Validate a URL for use in an `href`, returning `null` if it is unusable.
 *
 * WHY THIS EXISTS SEPARATELY FROM ESCAPING: {@link escapeHtml} stops a value
 * from breaking OUT of an attribute, which is the injection this module is
 * mainly about. It does nothing about a value that stays inside the attribute
 * and is hostile there — `javascript:...` is perfectly well-formed once
 * escaped. Escaping and scheme-checking are two different jobs and only one of
 * them can be done by the `html` tag, which cannot know it is looking at a URL.
 *
 * RELATIVE URLS ARE REJECTED TOO, and that is not incidental strictness. An
 * email has no document base to resolve against, so a relative href is already
 * broken for every recipient — catching it here turns a dead link in somebody's
 * inbox into a visible absence at render time.
 *
 * Returns `null` rather than a placeholder such as `#`: callers (see the CTA
 * handling in layout.ts) drop the link entirely, because a button that
 * silently goes nowhere is harder to diagnose than a button that is not there.
 */
export function safeUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return ALLOWED_URL_SCHEMES.has(parsed.protocol) ? value : null;
  } catch {
    // Not parseable as an absolute URL. Includes the relative-URL case above.
    return null;
  }
}
