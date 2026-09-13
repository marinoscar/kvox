import { broadcastEmail, type BroadcastEmailData } from './broadcast.email';

// =============================================================================
// broadcast.email.ts — tests (issue #322, epic #319)
// =============================================================================
//
// THIS IS THE ONE TEMPLATE WHOSE INPUT IS UNTRUSTED CONTENT, so its suite is
// weighted differently from the registry-wide contract loop in index.spec.ts.
// That loop already proves the generic properties every template shares — a
// non-empty subject/html/text, a table-based document, no `<link>`, no
// `<style>`, no external `src` — and it feeds this template hostile data as
// part of that sweep. What it cannot check is the behaviour that is specific
// to rendering an administrator's typing:
//
//   1. ESCAPING, on the two fields an admin actually controls, asserted in
//      both directions — escaped in the HTML part, RAW in the text part. The
//      second half matters as much as the first: a text/plain MIME part is
//      never parsed as markup, so escaping it would only make a legitimate
//      message unreadable for a text-client reader.
//   2. PARAGRAPH SPLITTING, which is the whole reason the body is plain text
//      rather than markup, and the only place this file interprets the input
//      at all.
//   3. The SUBJECT being the admin's title verbatim, which is a product
//      decision (#322 rejected an `APP_NAME` prefix) that a later "tidy-up"
//      would otherwise silently undo.
//   4. The CTA, including that a `javascript:` URL is dropped from BOTH parts
//      — the HTML half by `safeUrl` in the layout, the text half by `safeUrl`
//      in `plainText`. A URL rejected by one and copied out by the other would
//      hand the recipient the payload to paste into their own address bar.
//   5. The `critical` footer, present and absent, since it is the only
//      difference between the two event keys that share this template.
// =============================================================================

/** The tag-shaped payload used throughout, matching index.spec.ts's fixtures. */
const SCRIPT_PAYLOAD = '<script>alert(1)</script>';
const SCRIPT_ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';

/** An attribute-breakout attempt: the double quote is the interesting part. */
const QUOTE_PAYLOAD = 'He said "maintenance" is at 22:00';
const QUOTE_ESCAPED = 'He said &quot;maintenance&quot; is at 22:00';

function render(overrides: Partial<BroadcastEmailData> = {}) {
  const data: BroadcastEmailData = {
    title: 'Planned maintenance this Saturday',
    body: 'The application will be unavailable from 22:00 UTC.',
    ...overrides,
  };

  return broadcastEmail(data);
}

describe('broadcastEmail — escaping the admin-composed body', () => {
  it('escapes a <script> payload and a double quote in the html part', () => {
    const out = render({ body: `${SCRIPT_PAYLOAD}\n\n${QUOTE_PAYLOAD}` });

    expect(out.html).not.toContain(SCRIPT_PAYLOAD);
    expect(out.html).toContain(SCRIPT_ESCAPED);
    expect(out.html).toContain(QUOTE_ESCAPED);
  });

  it('leaves the same payload RAW in the text part (a text/plain part is not markup)', () => {
    const out = render({ body: `${SCRIPT_PAYLOAD}\n\n${QUOTE_PAYLOAD}` });

    expect(out.text).toContain(SCRIPT_PAYLOAD);
    expect(out.text).toContain(QUOTE_PAYLOAD);
    expect(out.text).not.toContain('&lt;script&gt;');
    expect(out.text).not.toContain('&quot;');
  });

  it('never reaches for the escape hatch — no unescaped markup survives from the body', () => {
    // A breakout attempt aimed at the surrounding `<p style="...">`, which is
    // the exact shape the `html` tag exists to defuse.
    const out = render({ body: '"><img src=x onerror=alert(1)>' });

    expect(out.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(out.html).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('broadcastEmail — escaping the admin-composed title', () => {
  it('escapes a <script> payload and a double quote in the html part', () => {
    const out = render({ title: `${SCRIPT_PAYLOAD} ${QUOTE_PAYLOAD}` });

    expect(out.html).not.toContain(SCRIPT_PAYLOAD);
    expect(out.html).toContain(SCRIPT_ESCAPED);
    expect(out.html).toContain(QUOTE_ESCAPED);
  });

  it('leaves the title RAW in the text part and in the subject', () => {
    const title = `${SCRIPT_PAYLOAD} ${QUOTE_PAYLOAD}`;
    const out = render({ title });

    expect(out.text).toContain(title);
    expect(out.subject).toBe(title);
  });
});

describe('broadcastEmail — paragraphs', () => {
  it('renders one <p> per blank-line-separated paragraph', () => {
    const out = render({ body: 'First para.\n\nSecond para.\n\nThird para.' });

    const paragraphs = out.html.match(/<p style="margin:[^"]*;">/g) ?? [];
    expect(paragraphs).toHaveLength(3);
    expect(out.html).toContain('First para.');
    expect(out.html).toContain('Second para.');
    expect(out.html).toContain('Third para.');
  });

  it('joins a single newline inside a paragraph with a space rather than splitting it', () => {
    // A soft wrap from the composer's textarea. Mail clients reflow to the
    // reader's window, so this must not become two paragraphs or a hard break.
    const out = render({ body: 'One sentence\nwrapped by the textarea.' });

    const paragraphs = out.html.match(/<p style="margin:[^"]*;">/g) ?? [];
    expect(paragraphs).toHaveLength(1);
    expect(out.html).toContain('One sentence wrapped by the textarea.');
  });

  it('treats a blank line containing whitespace, and a run of them, as one separator', () => {
    const out = render({ body: 'First.\n   \n\n\nSecond.' });

    const paragraphs = out.html.match(/<p style="margin:[^"]*;">/g) ?? [];
    expect(paragraphs).toHaveLength(2);
  });

  it('drops trailing blank lines rather than rendering empty paragraphs', () => {
    const out = render({ body: 'Only one.\n\n\n' });

    const paragraphs = out.html.match(/<p style="margin:[^"]*;">/g) ?? [];
    expect(paragraphs).toHaveLength(1);
  });

  it('carries every paragraph into a non-empty text part, blank-line separated', () => {
    const out = render({ body: 'First para.\n\nSecond para.\n\nThird para.' });

    expect(out.text.trim().length).toBeGreaterThan(0);
    expect(out.text).toContain('First para.');
    expect(out.text).toContain('Second para.');
    expect(out.text).toContain('Third para.');
    expect(out.text).toContain('First para.\r\n\r\nSecond para.');
  });

  it('renders a whitespace-only body as a titled message rather than throwing', () => {
    // Unreachable through the composer (the DTO requires a non-empty body),
    // but `plainText` takes a NON-EMPTY tuple, so the degenerate case has to
    // have a defined answer rather than a `lines[0]!` waiting to be undefined.
    expect(() => render({ body: '   \n\n  ' })).not.toThrow();

    const out = render({ body: '   \n\n  ' });
    expect(out.subject).toBe('Planned maintenance this Saturday');
    expect(out.text).toContain('Planned maintenance this Saturday');
  });
});

describe('broadcastEmail — subject', () => {
  it('is the title verbatim, with no APP_NAME prefix or suffix', () => {
    const title = 'Planned maintenance this Saturday';
    expect(render({ title }).subject).toBe(title);
  });

  it('preserves leading/trailing characters exactly, including punctuation', () => {
    const title = '  [URGENT] Read this — 100% of users affected  ';
    expect(render({ title }).subject).toBe(title);
  });
});

describe('broadcastEmail — call to action', () => {
  it('renders no CTA block when ctaUrl is absent', () => {
    const out = render({ ctaLabel: 'Read the status page' });

    expect(out.html).not.toContain('Read the status page');
    expect(out.html).not.toMatch(/<a\s+href=/i);
    expect(out.text).not.toContain('Read the status page');
  });

  it('renders the CTA in both parts when ctaUrl is an absolute https URL', () => {
    const out = render({
      ctaLabel: 'Read the status page',
      ctaUrl: 'https://status.example.com/incident/42',
    });

    expect(out.html).toContain('https://status.example.com/incident/42');
    expect(out.html).toContain('Read the status page');
    expect(out.text).toContain(
      'Read the status page: https://status.example.com/incident/42',
    );
  });

  it('still links when a ctaUrl is given with no label, using a default', () => {
    const out = render({ ctaUrl: 'https://app.example.com/announcements' });

    expect(out.html).toContain('https://app.example.com/announcements');
    expect(out.text).toContain('https://app.example.com/announcements');
  });

  it('drops a javascript: ctaUrl from BOTH the html and the text part', () => {
    // The two halves check the scheme independently (`safeUrl` in the layout,
    // `safeUrl` again in `plainText`). A URL refused by the HTML half and then
    // written out in the text half would be worse than not checking at all —
    // it would be the payload, handed to the recipient to paste in themselves.
    const out = render({
      ctaLabel: 'Click here',
      // eslint-disable-next-line no-script-url
      ctaUrl: 'javascript:alert(document.cookie)',
    });

    expect(out.html).not.toContain('javascript:');
    expect(out.html).not.toContain('Click here');
    expect(out.text).not.toContain('javascript:');
    expect(out.text).not.toContain('Click here');
  });

  it('drops a root-relative ctaUrl, which has no base to resolve against in an inbox', () => {
    const out = render({ ctaLabel: 'Open', ctaUrl: '/announcements' });

    expect(out.html).not.toMatch(/href="\/announcements"/);
    expect(out.text).not.toContain('Open: /announcements');
  });

  it('ignores `link`, which belongs to the browser and push channels', () => {
    const out = render({ link: '/announcements/42' });

    expect(out.html).not.toContain('/announcements/42');
    expect(out.text).not.toContain('/announcements/42');
  });
});

describe('broadcastEmail — the critical footer', () => {
  const CANNOT_BE_TURNED_OFF = 'cannot be turned off';

  it('adds the cannot-be-muted line to both parts when critical is true', () => {
    const out = render({ critical: true });

    expect(out.html).toContain(CANNOT_BE_TURNED_OFF);
    expect(out.text).toContain(CANNOT_BE_TURNED_OFF);
  });

  it('omits it when critical is absent', () => {
    const out = render();

    expect(out.html).not.toContain(CANNOT_BE_TURNED_OFF);
    expect(out.text).not.toContain(CANNOT_BE_TURNED_OFF);
  });

  it('omits it when critical is explicitly false', () => {
    const out = render({ critical: false });

    expect(out.html).not.toContain(CANNOT_BE_TURNED_OFF);
    expect(out.text).not.toContain(CANNOT_BE_TURNED_OFF);
  });
});

describe('broadcastEmail — headers', () => {
  it('carries the transactional auto-response suppression headers', () => {
    const out = render();

    expect(out.headers).toEqual({
      'Auto-Submitted': 'auto-generated',
      'X-Auto-Response-Suppress': 'All',
    });
  });
});
