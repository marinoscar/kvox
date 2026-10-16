import {
  configureEmailRendering,
  currentEmailRenderContext,
  withLayoutAttachments,
  type EmailTemplate,
  type RenderedEmail,
} from '@marinoscar/platform-api/email';

import { EMAIL_MODULE_OPTIONS } from '../platform/email/email.options';
import { EMAIL_LOGO_CID } from './brand-logo';
import {
  KVOX_EMAIL_TEMPLATES,
  KVOX_EMAIL_TEMPLATE_OVERRIDES,
  registerKvoxEmailTemplates,
} from './index';

// =============================================================================
// This app's email templates -- the contract every one of them shares
// =============================================================================
//
// The platform's own conformance suite and tests cover the layout, the safe-HTML
// helpers, the registry and the nine platform templates. What is asserted HERE
// is what stays this app's: the names it registers (PERSISTED by delivery
// records and the preference matrix, so a change is a break), and the contract
// over its own renderers -- non-empty parts, escaping of every interpolated
// field, nothing fetched, the brand mark's inline part present exactly when the
// markup references it.
// =============================================================================

const HOSTILE_SCRIPT = '<script>alert(document.cookie)</script>';
const HOSTILE_IMG = '"><img src=x onerror=alert(1)>';

/** One representative, deliberately hostile payload per template this app registers or overrides. */
const SAMPLE_DATA: Record<string, unknown> = {
  'allowlist-invitation-reminder': {
    recipientEmail: `${HOSTILE_SCRIPT}@example.com`,
    invitedAt: new Date('2026-01-15T10:00:00.000Z'),
    invitedBy: HOSTILE_IMG,
    signInUrl: 'https://app.example.com/login',
  },
  'transcript-ready': {
    transcriptId: 'transcript-1',
    title: 'Board meeting, 3 March',
    durationMs: 3_725_000,
    speakerCount: 4,
    wordCount: 18_402,
    providerLabel: HOSTILE_SCRIPT,
    appUrl: 'https://app.example.com',
  },
  'transcript-failed': {
    transcriptId: 'transcript-1',
    title: 'Board meeting, 3 March',
    reason: HOSTILE_SCRIPT,
    stage: HOSTILE_IMG,
    retryable: true,
    appUrl: 'https://app.example.com',
  },
  'transcript-shared': {
    transcriptId: 'transcript-1',
    title: HOSTILE_SCRIPT,
    role: 'editor',
    ownerName: 'Ana Rivera',
    appUrl: 'https://app.example.com',
  },
  'note-ready': {
    noteId: 'note-1',
    title: 'Board meeting notes, 3 March',
    templateName: HOSTILE_SCRIPT,
    providerLabel: 'OpenAI',
    model: HOSTILE_IMG,
    wordCount: 412,
    appUrl: 'https://app.example.com',
  },
  'note-failed': {
    noteId: 'note-1',
    title: 'Board meeting notes, 3 March',
    reason: HOSTILE_SCRIPT,
    category: HOSTILE_IMG,
    appUrl: 'https://app.example.com',
  },
  'user-welcome': {
    recipientEmail: `${HOSTILE_SCRIPT}@example.com`,
    recipientName: HOSTILE_IMG,
    roles: ['viewer'],
    appUrl: 'https://app.example.com',
  },
  'allowlist-invitation': {
    recipientEmail: `${HOSTILE_SCRIPT}@example.com`,
    invitedBy: HOSTILE_IMG,
    signInUrl: 'https://app.example.com/login',
  },
};

const RENDERERS: Array<[string, EmailTemplate<never>]> = [
  ...KVOX_EMAIL_TEMPLATES.map((entry): [string, EmailTemplate<never>] => [entry.name, entry.render]),
  ...Object.entries(KVOX_EMAIL_TEMPLATE_OVERRIDES).map(
    ([name, render]): [string, EmailTemplate<never>] => [name, render as EmailTemplate<never>],
  ),
];

// At module scope, not in `beforeAll`: `describe.each` below renders while Jest
// is still collecting the tests.
configureEmailRendering(EMAIL_MODULE_OPTIONS);

/** Renders the way the registry does: the template, then the layout's inline parts. */
function render(name: string, template: EmailTemplate<never>): RenderedEmail {
  const rendered = (template as EmailTemplate<unknown>)(SAMPLE_DATA[name]);
  return withLayoutAttachments(rendered, currentEmailRenderContext());
}

/**
 * Does this document fetch anything? Strip embedded `src="cid:..."` references,
 * then apply the "any src= inside a real tag" rule to the remainder
 * (strip-then-match, not one negative-lookahead regex, which backtracks past
 * the quote and reports every embedded reference as remote).
 */
function fetchesRemoteContent(document: string): boolean {
  const withoutEmbedded = document.replace(/\bsrc\s*=\s*"cid:[^"]*"/gi, '');

  return /<[a-zA-Z][a-zA-Z0-9-]*\b[^>]*\bsrc\s*=/i.test(withoutEmbedded);
}

/** Every content id the document references, as it appears after `cid:`. */
function referencedContentIds(document: string): string[] {
  return [...document.matchAll(/\bsrc\s*=\s*"cid:([^"]*)"/gi)].map((match) => match[1] ?? '');
}

describe('the names this app registers are persisted and stay put', () => {
  it('registers exactly the reminder, the three transcript and the two note templates', () => {
    expect(KVOX_EMAIL_TEMPLATES.map((entry) => entry.name)).toEqual([
      'allowlist-invitation-reminder',
      'transcript-ready',
      'transcript-failed',
      'transcript-shared',
      'note-ready',
      'note-failed',
    ]);
  });

  it('overrides exactly the two platform names whose copy differs from the platform’s', () => {
    expect(Object.keys(KVOX_EMAIL_TEMPLATE_OVERRIDES).sort()).toEqual(['allowlist-invitation', 'user-welcome']);
  });

  it('keeps no template of its own under a platform name it does not override', () => {
    // `role-changed` is the platform's (identical copy), `test-email`,
    // `broadcast`, `job-failed`, `node-offline`, `backup-failed` and
    // `restore-completed` too: a second registration under one of those names
    // would throw DUPLICATE_ID at import.
    const platformNames = [
      'test-email',
      'user-welcome',
      'allowlist-invitation',
      'role-changed',
      'broadcast',
      'job-failed',
      'node-offline',
      'backup-failed',
      'restore-completed',
    ];

    for (const entry of KVOX_EMAIL_TEMPLATES) {
      expect(platformNames).not.toContain(entry.name);
    }
  });

  it('has a sample payload for every renderer (a template added without one fails here)', () => {
    expect(RENDERERS.map(([name]) => name).sort()).toEqual(Object.keys(SAMPLE_DATA).sort());
  });
});

describe('registerKvoxEmailTemplates', () => {
  it('registers the six names and swaps in this app’s wording for the two overridden ones', () => {
    jest.isolateModules(() => {
      // A fresh copy of the package, so a fresh registry: the process-wide one
      // belongs to the app's own bootstrap.
      const email = require('@marinoscar/platform-api/email') as typeof import('@marinoscar/platform-api/email');
      const mine = require('./index') as typeof import('./index');

      email.registerPlatformEmailTemplates();
      mine.registerKvoxEmailTemplates();
      // Idempotent: a second call neither throws nor registers twice.
      expect(() => mine.registerKvoxEmailTemplates()).not.toThrow();

      for (const entry of mine.KVOX_EMAIL_TEMPLATES) {
        expect(email.isEmailTemplateName(entry.name)).toBe(true);
      }
      expect(email.listEmailTemplateOverrides().map((o) => o.name).sort()).toEqual([
        'allowlist-invitation',
        'user-welcome',
      ]);

      const ctx = email.createEmailRenderContext(EMAIL_MODULE_OPTIONS);
      const welcome = email.renderEmailTemplate(
        'user-welcome',
        { recipientEmail: 'sam@example.test', roles: ['viewer'], appUrl: 'https://app.example.test' },
        ctx,
      );

      // This app's button opens the getting-started checklist; the platform's
      // opens the app root.
      expect(welcome.html).toContain('https://app.example.test/settings/getting-started');
    });
  });
});

describe.each(RENDERERS)('template contract: "%s"', (name, template) => {
  const rendered = render(name, template);

  it('returns a non-empty subject, html and text', () => {
    expect(rendered.subject.trim().length).toBeGreaterThan(0);
    expect(rendered.html.trim().length).toBeGreaterThan(0);
    expect(rendered.text.trim().length).toBeGreaterThan(0);
  });

  it('subject carries no HTML markup', () => {
    expect(rendered.subject).not.toMatch(/<[a-zA-Z!/][^>]*>/);
  });

  it('escapes the html part and leaves the text part as plain text', () => {
    expect(rendered.html).not.toContain(HOSTILE_SCRIPT);
    expect(rendered.html).not.toContain('<img src=x onerror=alert(1)>');

    if (JSON.stringify(SAMPLE_DATA[name]).includes('script')) {
      expect(rendered.html).toContain('&lt;script&gt;alert(document.cookie)&lt;/script&gt;');
      expect(rendered.text).toContain(HOSTILE_SCRIPT);
      expect(rendered.text).not.toContain('&lt;script&gt;');
    }
  });

  it('html is table-based, has no <link> or <style> and fetches nothing', () => {
    expect(rendered.html).toMatch(/<table\b/i);
    expect(rendered.html).not.toMatch(/<link\b/i);
    expect(rendered.html).not.toMatch(/<style\b/i);
    expect(fetchesRemoteContent(rendered.html)).toBe(false);
  });

  it('references the brand mark and attaches exactly the part it references', () => {
    const referenced = referencedContentIds(rendered.html);
    const attached = (rendered.attachments ?? []).map((a) => a.contentId);

    expect(referenced).toEqual([EMAIL_LOGO_CID]);
    expect(attached).toEqual([EMAIL_LOGO_CID]);
  });

  it('carries the transactional headers (no auto-replies)', () => {
    expect(rendered.headers).toBeDefined();
    expect(Object.keys(rendered.headers ?? {}).length).toBeGreaterThan(0);
  });
});
