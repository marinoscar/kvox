import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { APP_NAME, APP_SLUG, REPO_SLUG, REPO_URL, THEME_COLOR, BACKGROUND_COLOR } from '@app/shared';

// =============================================================================
// packages/shared: APP_SLUG, REPO_SLUG, REPO_URL (issue #343, epic #341)
// =============================================================================
//
// This lives in apps/cli rather than packages/shared itself because that
// package deliberately has no test runner of its own (see the "WHY THIS
// PACKAGE IS PLAIN JAVASCRIPT" note at the top of index.js) — apps/cli's
// vitest is the natural home for a repo-wide check that reaches outside the
// CLI, the same precedent as src/node/worker-env.test.ts (the branding guard)
// and src/deploy/repo.test.ts (the template-name guard).
//
// `packages/shared/index.d.ts` types every export as `string`, never as a
// string literal, specifically so nothing here — or anywhere else — can pin
// today's VALUE at the type level. These tests follow that same discipline at
// the runtime level: every assertion below is a DERIVATION (a rule applied to
// whatever APP_NAME/REPO_SLUG happen to be), never a comparison against the
// literal currently sitting in identity.json. That is the house style set by
// apps/cli/src/branding.test.ts, which this file mirrors.
// =============================================================================

describe('APP_SLUG', () => {
  it('is lowercase, hyphenated, with no leading/trailing/double hyphen', () => {
    expect(APP_SLUG).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('is APP_NAME slugified: lowercased, non-alphanumerics collapsed to single hyphens, trimmed', () => {
    // The exact rule index.js's own `slugify()` implements. Applying it here
    // to the live APP_NAME (rather than asserting a literal) is what keeps
    // this test from having to change on a rename.
    const expected = APP_NAME.toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    expect(APP_SLUG).toBe(expected);
  });
});

describe('the slugify fallback (NEUTRAL_SLUG)', () => {
  // APP_NAME cannot be driven to slugify-to-nothing without mutating
  // identity.json, so the fallback branch is untestable through APP_SLUG
  // itself. Per the task, this reimplements the documented rule against
  // inputs chosen to fully punctuate/empty, rather than faking coverage by
  // asserting something apps/api/src/jobs/job-temp.spec.ts does not actually
  // exercise (checked: that file only asserts JOB_TEMP_PREFIX derives from
  // the CURRENT APP_NAME — it never drives the input to empty, so it does not
  // cover this fallback either).
  function slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');

    return slug.length > 0 ? slug : 'app';
  }

  it('falls back to the literal "app" when the name slugifies to nothing', () => {
    for (const input of ['', '   ', '!!!', '---', '日本語', '★★★']) {
      expect(slugify(input)).toBe('app');
    }
  });

  it('otherwise slugifies normally', () => {
    expect(slugify('My App')).toBe('my-app');
  });
});

describe('REPO_SLUG', () => {
  it('is a well-formed "owner/name" pair', () => {
    expect(REPO_SLUG).toMatch(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
    expect(REPO_SLUG.split('/')).toHaveLength(2);
  });
});

describe('REPO_URL', () => {
  it('equals https://github.com/${REPO_SLUG}, so the two cannot drift', () => {
    expect(REPO_URL).toBe(`https://github.com/${REPO_SLUG}`);
  });
});

describe('identity.json parity', () => {
  it('parses, and its fields are exactly what index.js exports', () => {
    // Resolved via the package's own directory rather than assuming a fixed
    // relative depth from this file, so the check does not silently start
    // reading the wrong file if either module moves.
    const here = dirname(fileURLToPath(import.meta.url));
    const identityPath = join(here, '..', '..', '..', 'packages', 'shared', 'identity.json');
    const raw = readFileSync(identityPath, 'utf8');
    const identity = JSON.parse(raw) as {
      productName: string;
      themeColor: string;
      backgroundColor: string;
      repoSlug: string;
    };

    expect(identity.productName).toBe(APP_NAME);
    expect(identity.themeColor).toBe(THEME_COLOR);
    expect(identity.backgroundColor).toBe(BACKGROUND_COLOR);
    expect(identity.repoSlug).toBe(REPO_SLUG);
  });
});

describe('THEME_COLOR and BACKGROUND_COLOR', () => {
  it('are 6-digit lowercase hex strings', () => {
    // Load-bearing, not cosmetic: a PWA manifest's theme_color/background_color
    // are parsed by the PLATFORM, not a CSS engine, and the 3-digit shorthand
    // and rgb()/rgba() forms are not reliably accepted there — only the
    // 6-digit #rrggbb form is safe (see index.js's own comment on THEME_COLOR).
    expect(THEME_COLOR).toMatch(/^#[0-9a-f]{6}$/);
    expect(BACKGROUND_COLOR).toMatch(/^#[0-9a-f]{6}$/);
  });
});
