import {
  EMAIL_TEMPLATES,
  EMAIL_TEMPLATE_NAMES,
  findEmailTemplate,
  isEmailTemplateName,
  renderEmailTemplate,
  renderedEmailParts,
  type EmailTemplateDataMap,
  type EmailTemplateName,
  type RenderedEmail,
} from './index';

// =============================================================================
// Email template registry — contract tests (issue #123, epic #109)
// =============================================================================
//
// #123 requires that EVERY template returns non-empty subject/html/text, and
// that requirement has to survive #128 adding three more templates without
// anybody remembering to extend this file by hand. So this suite loops over
// `EMAIL_TEMPLATE_NAMES` rather than naming `testEmail` directly, and the one
// place a new template *is* named explicitly — `SAMPLE_DATA` below — is typed
// so that registering a template without adding its sample payload here is a
// TypeScript compile error, not a silently-skipped test.
// =============================================================================

/**
 * One representative (and deliberately hostile) payload per registered
 * template. Typed as a total map over `EmailTemplateName`, so #128 adding
 * `'user.welcome'` to the registry without adding an entry here fails to
 * compile — the same "no half-registered template" guarantee `index.ts`
 * gives the registry itself, extended to this test file.
 */
const SAMPLE_DATA: { [K in EmailTemplateName]: EmailTemplateDataMap[K] } = {
  'test-email': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    providerKind: 'smtp',
    sentAt: new Date('2026-01-01T00:00:00.000Z'),
    triggeredBy: '"><img src=x onerror=alert(1)>',
    settingsUrl: 'https://app.example.com/admin/settings/email',
  },
  // #128's three real event templates. Each payload places the hostile
  // `<script>` fragment in a field the template renders into BOTH parts, and
  // the `onerror` fragment in a second escaped field, so the contract loop
  // below exercises escaping on every one of them rather than only on the
  // first field a template happens to interpolate.
  'user-welcome': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    recipientName: '"><img src=x onerror=alert(1)>',
    roles: ['viewer'],
    appUrl: 'https://app.example.com',
  },
  'allowlist-invitation': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    invitedBy: '"><img src=x onerror=alert(1)>',
    signInUrl: 'https://app.example.com/login',
  },
  'role-changed': {
    recipientEmail: '<script>alert(document.cookie)</script>@example.com',
    previousRoles: ['admin'],
    currentRoles: ['"><img src=x onerror=alert(1)>'],
    changedAt: new Date('2026-01-01T00:00:00.000Z'),
    appUrl: 'https://app.example.com',
  },
  // #322's broadcast. The hostile fragments go in the BODY and not in the
  // title, because this template's subject is the title verbatim and the
  // contract loop below (rightly) requires a subject with no markup in it —
  // an escaped subject would mail the recipient a literal `&lt;`. The body is
  // the field an administrator types into anyway, so it is also the honest
  // place to aim the payload. See broadcast.email.spec.ts for the escaping
  // assertions specific to this template.
  broadcast: {
    title: 'Planned maintenance this Saturday',
    body:
      '<script>alert(document.cookie)</script>\n\n' +
      '"><img src=x onerror=alert(1)>',
    ctaLabel: 'Read the status page',
    ctaUrl: 'https://status.example.com/incident/42',
    link: '/announcements/42',
    critical: true,
  },
  // #288's four operational templates (epic #254). THE HOSTILE FRAGMENTS ARE
  // PLACED WITH CARE, because the contract loop below imposes two requirements
  // at once: the `<script>` payload must reach BOTH the html part (escaped) and
  // the text part (verbatim), and the SUBJECT must carry no markup at all. So
  // in every payload here the hostile values go in fields the body renders and
  // the subject does not — `error`, `executor`, `nodeName`, `triggeredBy` — and
  // the fields that DO reach a subject line (`jobType`) are benign.
  'job-failed': {
    jobId: 'job-1',
    // Reaches the subject, so it stays benign on purpose.
    jobType: 'admin.broadcast.chunk',
    error: '<script>alert(document.cookie)</script>',
    attempts: 5,
    executor: '"><img src=x onerror=alert(1)>',
    failedAt: new Date('2026-01-01T00:00:00.000Z'),
    appUrl: 'https://app.example.com',
  },
  'node-offline': {
    nodeId: 'node-1',
    nodeName: '<script>alert(document.cookie)</script>',
    lastHeartbeatAt: new Date('2026-01-01T00:00:00.000Z'),
    markedOfflineAt: new Date('2026-01-01T00:06:00.000Z'),
    staleAfterMinutes: 6,
    appUrl: 'https://app.example.com',
  },
  'backup-failed': {
    runId: '"><img src=x onerror=alert(1)>',
    outcome: 'failed',
    error: '<script>alert(document.cookie)</script>',
    startedAt: new Date('2026-01-01T00:00:00.000Z'),
    failedAt: new Date('2026-01-01T00:10:00.000Z'),
    trigger: 'scheduled',
    appUrl: 'https://app.example.com',
  },
  'restore-completed': {
    runId: '"><img src=x onerror=alert(1)>',
    backupTakenAt: new Date('2026-01-01T00:00:00.000Z'),
    completedAt: new Date('2026-01-02T00:00:00.000Z'),
    triggeredBy: '<script>alert(document.cookie)</script>@example.com',
    preRestoreBackupId: 'run-pre-restore',
    appUrl: 'https://app.example.com',
  },
  // #25's two owner-addressed templates (epic #19). Same placement rule as the
  // four above: `title` reaches the SUBJECT of both, so it stays benign, and
  // the hostile fragments go in fields only the body renders — `providerLabel`
  // for the ready message, `reason` and `stage` for the failure.
  'transcript-ready': {
    transcriptId: 'transcript-1',
    // Reaches the subject, so it stays benign on purpose.
    title: 'Board meeting, 3 March',
    durationMs: 3_725_000,
    speakerCount: 4,
    wordCount: 18_402,
    providerLabel: '<script>alert(document.cookie)</script>',
    appUrl: 'https://app.example.com',
  },
  'transcript-failed': {
    transcriptId: 'transcript-1',
    // Reaches the subject, so it stays benign on purpose.
    title: 'Board meeting, 3 March',
    reason: '<script>alert(document.cookie)</script>',
    stage: '"><img src=x onerror=alert(1)>',
    retryable: true,
    appUrl: 'https://app.example.com',
  },
  // #29's recipient-addressed template. `ownerName` reaches the subject and so
  // stays benign; `title` deliberately does NOT (see that template's note on
  // why a private recording's title stays off a lock screen), which is exactly
  // what makes it the field the hostile fragment goes in.
  'transcript-shared': {
    transcriptId: 'transcript-1',
    title: '<script>alert(document.cookie)</script>',
    role: 'editor',
    ownerName: 'Ana Rivera',
    appUrl: 'https://app.example.com',
  },
  // #49's two note payloads (epic #45). Same placement rule as the transcript
  // pair above: `title` reaches the SUBJECT of both, so it stays benign, and
  // the hostile fragments go in fields only the body renders — `templateName`
  // and `model` for the ready message, `reason` and `category` for the failure.
  'note-ready': {
    noteId: 'note-1',
    // Reaches the subject, so it stays benign on purpose.
    title: 'Board meeting notes, 3 March',
    templateName: '<script>alert(document.cookie)</script>',
    providerLabel: 'OpenAI',
    model: '"><img src=x onerror=alert(1)>',
    wordCount: 412,
    appUrl: 'https://app.example.com',
  },
  'note-failed': {
    noteId: 'note-1',
    // Reaches the subject, so it stays benign on purpose.
    title: 'Board meeting notes, 3 March',
    reason: '<script>alert(document.cookie)</script>',
    category: '"><img src=x onerror=alert(1)>',
    appUrl: 'https://app.example.com',
  },
};

function render(name: EmailTemplateName): RenderedEmail {
  const template = EMAIL_TEMPLATES[name] as (data: unknown) => RenderedEmail;
  return template(SAMPLE_DATA[name]);
}

/**
 * Does this document fetch anything? Strip embedded `src="cid:…"` references,
 * then apply the original "any src= inside a real tag" rule to the remainder.
 *
 * Written as strip-then-match rather than as one negative-lookahead regex: a
 * lookahead placed after an optional quote backtracks past the quote and
 * reports every `src="cid:…"` as remote — a false PASS wearing a clever
 * regex. The same helper, for the same reason, is in layout.spec.ts.
 */
function fetchesRemoteContent(document: string): boolean {
  const withoutEmbedded = document.replace(/\bsrc\s*=\s*"cid:[^"]*"/gi, '');

  return /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bsrc\s*=/i.test(withoutEmbedded);
}

/** Every content id the document references, as it appears after `cid:`. */
function referencedContentIds(document: string): string[] {
  return [...document.matchAll(/\bsrc\s*=\s*"cid:([^"]*)"/gi)].map(
    (match) => match[1] ?? '',
  );
}

describe('email template registry — keys and functions agree', () => {
  it('EMAIL_TEMPLATE_NAMES is exactly the key set of EMAIL_TEMPLATES', () => {
    expect([...EMAIL_TEMPLATE_NAMES].sort()).toEqual(Object.keys(EMAIL_TEMPLATES).sort());
  });

  it('has at least one registered template', () => {
    expect(EMAIL_TEMPLATE_NAMES.length).toBeGreaterThan(0);
  });

  it('has no duplicate names', () => {
    expect(new Set(EMAIL_TEMPLATE_NAMES).size).toBe(EMAIL_TEMPLATE_NAMES.length);
  });

  it('every registered name maps to a callable renderer', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(typeof EMAIL_TEMPLATES[name]).toBe('function');
    }
  });

  it('SAMPLE_DATA (this test file) covers every registered name — a name missing here is a compile error, not a skipped test', () => {
    expect(Object.keys(SAMPLE_DATA).sort()).toEqual([...EMAIL_TEMPLATE_NAMES].sort());
  });
});

describe('email template registry — lookup helpers', () => {
  it('isEmailTemplateName is true for every registered name', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(isEmailTemplateName(name)).toBe(true);
    }
  });

  it('isEmailTemplateName is false for an unregistered or empty string', () => {
    expect(isEmailTemplateName('not-a-real-template')).toBe(false);
    expect(isEmailTemplateName('')).toBe(false);
  });

  it('findEmailTemplate returns the exact registered function for a known name', () => {
    for (const name of EMAIL_TEMPLATE_NAMES) {
      expect(findEmailTemplate(name)).toBe(EMAIL_TEMPLATES[name]);
    }
  });

  it('findEmailTemplate returns undefined for an unknown name (never throws)', () => {
    expect(findEmailTemplate('decommissioned-template')).toBeUndefined();
  });

  it('renderEmailTemplate produces the same output as calling the registered function directly', () => {
    const data = SAMPLE_DATA['test-email'];
    expect(renderEmailTemplate('test-email', data)).toEqual(EMAIL_TEMPLATES['test-email'](data));
  });
});

describe('renderedEmailParts — the one bridge from a template to a message', () => {
  it('produces exactly the fields a message with no attachments always had', () => {
    // Both call sites (the notification dispatcher and the "send test email"
    // button) used to enumerate these by hand. The Pick proof in
    // email-template.types.ts catches a field that changes SHAPE; it cannot
    // catch a field a call site simply does not mention, because an optional
    // property left out still typechecks. So this pins the no-attachment case
    // exactly — no `attachments` key, not an empty one.
    const parts = renderedEmailParts({
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      headers: { 'X-A': '1' },
    });

    expect(parts).toEqual({
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      headers: { 'X-A': '1' },
    });
    expect('attachments' in parts).toBe(false);
  });

  it('omits both optional keys when the template supplied neither', () => {
    const parts = renderedEmailParts({ subject: 'S', html: '<p>h</p>', text: 't' });

    expect(Object.keys(parts).sort()).toEqual(['html', 'subject', 'text']);
  });

  it('treats an empty attachments array as no attachments', () => {
    const parts = renderedEmailParts({
      subject: 'S',
      html: '<p>h</p>',
      text: 't',
      attachments: [],
    });

    expect('attachments' in parts).toBe(false);
  });

  it('carries every attachment through by reference', () => {
    const attachment = {
      content: Buffer.from([1, 2, 3]),
      cid: 'logo@email.local',
      filename: 'logo.png',
      contentType: 'image/png',
    };

    const parts = renderedEmailParts({
      subject: 'S',
      html: '<p><img src="cid:logo@email.local"></p>',
      text: 't',
      attachments: [attachment],
    });

    expect(parts.attachments).toEqual([attachment]);
    expect(parts.attachments?.[0]).toBe(attachment);
  });

  it('loses nothing from any registered template', () => {
    // The whole registry, so a template that starts embedding something is
    // covered the day it is added rather than the day somebody remembers.
    for (const name of EMAIL_TEMPLATE_NAMES) {
      const rendered = render(name);
      const parts = renderedEmailParts(rendered);

      expect(parts.html).toBe(rendered.html);
      expect(parts.text).toBe(rendered.text);
      expect(parts.attachments ?? []).toEqual(rendered.attachments ?? []);
    }
  });
});

describe.each(EMAIL_TEMPLATE_NAMES)('template contract: "%s"', (name) => {
  const rendered = render(name);

  it('returns a non-empty subject', () => {
    expect(typeof rendered.subject).toBe('string');
    expect(rendered.subject.trim().length).toBeGreaterThan(0);
  });

  it('returns non-empty html', () => {
    expect(typeof rendered.html).toBe('string');
    expect(rendered.html.trim().length).toBeGreaterThan(0);
  });

  it('returns non-empty text', () => {
    expect(typeof rendered.text).toBe('string');
    expect(rendered.text.trim().length).toBeGreaterThan(0);
  });

  it('subject carries no HTML markup', () => {
    expect(rendered.subject).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  // NOTE: this loop deliberately feeds hostile, tag-shaped data through
  // every template (see SAMPLE_DATA above), so a plain "text contains no
  // HTML tags" assertion here would fail on the raw payload text — and
  // *should* fail: a text/plain MIME part is never parsed as markup by any
  // mail client, so literal "<script>" characters in it are inert data, not
  // an injection, and `plainText` is correct NOT to escape them (see the
  // header comment above `plainText` in layout.ts). The generic
  // "plainText output contains no HTML tags" check belongs with BENIGN
  // content instead — see layout.spec.ts's dedicated `plainText` suite.
  //
  // What IS a genuine contract to pin here: the same hostile value appears
  // ESCAPED in the html part and VERBATIM (raw) in the text part. If a
  // future change accidentally started HTML-escaping the text part (turning
  // "<script>" into "&lt;script&gt;" for a human reading a text-only
  // client), that would be a readability regression this test would catch.
  it('does not HTML-escape the text part (only the html part escapes; text is plain text, not markup)', () => {
    const hostileFragment = '<script>alert(document.cookie)</script>';
    expect(rendered.html).not.toContain(hostileFragment);
    expect(rendered.html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
    expect(rendered.text).toContain(hostileFragment);
    expect(rendered.text).not.toContain('&lt;script&gt;');
  });

  it('html has no <link>, no <style> block, and fetches nothing', () => {
    expect(rendered.html).not.toMatch(/<link\b/i);
    expect(rendered.html).not.toMatch(/<style\b/i);
    // ⚠ WIDENED, NOT WEAKENED — see `fetchesRemoteContent` above and
    // layout.ts's header. An embedded `cid:` part is delivered inside the
    // message; a remote asset is fetched, blocked by default in Gmail,
    // Outlook and Apple Mail, and read as a tracking pixel by spam filters.
    // Only the second is forbidden, and this still fails for `https://`, for
    // a protocol-relative `//host/x` and for a `data:` URI.
    expect(fetchesRemoteContent(rendered.html)).toBe(false);
  });

  it('references no content id it does not also attach', () => {
    // THE INVARIANT THAT MAKES THE FEATURE SAFE TO EXTEND, asserted over the
    // whole registry rather than over the one template that uses it today.
    // A `cid:` with no MIME part behind it renders as a broken-image
    // placeholder in the recipient's client — strictly worse than the text
    // wordmark it replaced, and invisible to every test that only looks at
    // the markup. `RenderLayoutOptions.logo` takes the whole attachment
    // specifically so the two are produced from one value; this is the guard
    // for the template that finds a way around that anyway.
    const attached = new Set((rendered.attachments ?? []).map((a) => a.cid));

    for (const cid of referencedContentIds(rendered.html)) {
      expect(attached).toContain(cid);
    }
  });

  it('attaches no part the html does not reference', () => {
    // The other direction: `EmailMessage.attachments` is for EMBEDDED IMAGES,
    // not for files (see email.types.ts). A part nothing references is either
    // a leak of bytes into every copy of the message or the beginning of a
    // general file-attachment channel, and both should be a conversation
    // rather than a diff.
    const referenced = referencedContentIds(rendered.html);

    for (const attachment of rendered.attachments ?? []) {
      expect(referenced).toContain(attachment.cid);
    }
  });

  it('html is table-based', () => {
    expect(rendered.html).toMatch(/<table\b/i);
  });

  it('escapes the hostile sample data — no raw <script> or unescaped onerror= handler in the rendered html', () => {
    expect(rendered.html).not.toContain('<script>alert(document.cookie)</script>');
    expect(rendered.html).not.toContain('<img src=x onerror=alert(1)>');
  });
});
