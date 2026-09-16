import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  bundledTemplateFor,
  bundledTemplateMatches,
  readBundledTemplate,
  type BundledTemplate,
} from './bundled-template.js';

// =============================================================================
// readBundledTemplate / bundledTemplateMatches / bundledTemplateFor  (#236)
// =============================================================================
//
// `readBundledTemplate` is driven with a real temp directory passed as `root`
// — never a mocked `node:fs` — because the whole point of the function is
// reading two real files off disk and failing closed on anything not exactly
// right (missing directory, missing file, malformed JSON, a JSON value that
// is not what was expected). A mock can only assert that the function called
// the mock the way the test expected it to; it proves nothing about what
// happens when the real filesystem hands back an ENOENT.
//
// `bundledTemplateMatches` is the #229 guarantee applied one layer up (#236):
// a bundled template belongs to the repository THIS CLI WAS BUILT FROM, which
// need not be the repository `--repo` names, and handing one repository's
// variable list to another's install is exactly the defect #229 fixed for the
// local-checkout template source. The "different GitHub repository" case
// below is the single most important assertion in this file for that reason.
// =============================================================================

const createdRoots: string[] = [];

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'bundled-template-'));
  createdRoots.push(root);
  return root;
}

/** Writes `template/.env.example` and `template/source.json` under `root`. */
function writeBundle(
  root: string,
  options: {
    envContents?: string;
    sourceJson?: string | object | undefined;
    skipEnvFile?: boolean;
    skipSourceFile?: boolean;
  } = {},
): void {
  const dir = join(root, 'template');
  mkdirSync(dir, { recursive: true });

  if (options.skipEnvFile !== true) {
    writeFileSync(join(dir, '.env.example'), options.envContents ?? 'KEY=value\n');
  }

  if (options.skipSourceFile !== true) {
    const body =
      options.sourceJson === undefined
        ? JSON.stringify({ repoUrl: 'https://github.com/acme/widgets', ref: 'main' })
        : typeof options.sourceJson === 'string'
          ? options.sourceJson
          : JSON.stringify(options.sourceJson);
    writeFileSync(join(dir, 'source.json'), body);
  }
}

afterEach(() => {
  while (createdRoots.length > 0) {
    const root = createdRoots.pop();
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
  }
});

describe('readBundledTemplate', () => {
  it('returns contents, repoUrl and ref for a well-formed bundle', () => {
    const root = makeRoot();
    writeBundle(root, {
      envContents: 'KEY=value\nOTHER=1\n',
      sourceJson: { repoUrl: 'https://github.com/acme/widgets', ref: 'v1.2.3' },
    });

    expect(readBundledTemplate(root)).toEqual({
      contents: 'KEY=value\nOTHER=1\n',
      repoUrl: 'https://github.com/acme/widgets',
      ref: 'v1.2.3',
    });
  });

  it('defaults ref to empty string when source.json omits it', () => {
    const root = makeRoot();
    writeBundle(root, { sourceJson: { repoUrl: 'https://github.com/acme/widgets' } });

    expect(readBundledTemplate(root)).toEqual({
      contents: 'KEY=value\n',
      repoUrl: 'https://github.com/acme/widgets',
      ref: '',
    });
  });

  it('is undefined when the template directory does not exist at all', () => {
    const root = makeRoot();
    // Nothing written under root/template.
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when .env.example is missing', () => {
    const root = makeRoot();
    writeBundle(root, { skipEnvFile: true });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when source.json is missing', () => {
    const root = makeRoot();
    writeBundle(root, { skipSourceFile: true });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when source.json is malformed JSON', () => {
    const root = makeRoot();
    writeBundle(root, { sourceJson: '{ not valid json' });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when source.json has no repoUrl', () => {
    const root = makeRoot();
    writeBundle(root, { sourceJson: { ref: 'main' } });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when source.json has an empty repoUrl', () => {
    const root = makeRoot();
    writeBundle(root, { sourceJson: { repoUrl: '' } });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined when source.json is not a JSON object (e.g. an array or null)', () => {
    const root = makeRoot();
    writeBundle(root, { sourceJson: '[]' });
    expect(readBundledTemplate(root)).toBeUndefined();

    const root2 = makeRoot();
    writeBundle(root2, { sourceJson: 'null' });
    expect(readBundledTemplate(root2)).toBeUndefined();
  });

  it('is undefined for an empty template file', () => {
    const root = makeRoot();
    writeBundle(root, { envContents: '' });
    expect(readBundledTemplate(root)).toBeUndefined();
  });

  it('is undefined for a whitespace-only template file', () => {
    const root = makeRoot();
    writeBundle(root, { envContents: '   \n  \n' });
    expect(readBundledTemplate(root)).toBeUndefined();
  });
});

describe('bundledTemplateMatches', () => {
  function bundled(repoUrl: string, ref = ''): BundledTemplate {
    return { contents: 'KEY=value\n', repoUrl, ref };
  }

  it('is true for the same GitHub repository written as https, git@ and ssh://', () => {
    const https = bundled('https://github.com/acme/widgets.git');

    expect(bundledTemplateMatches(https, 'https://github.com/acme/widgets.git')).toBe(true);
    expect(bundledTemplateMatches(https, 'git@github.com:acme/widgets.git')).toBe(true);
    expect(bundledTemplateMatches(https, 'ssh://git@github.com/acme/widgets')).toBe(true);
  });

  it('is case-insensitive on the slug', () => {
    const bundledUpper = bundled('https://github.com/Acme/Widgets.git');
    expect(bundledTemplateMatches(bundledUpper, 'https://github.com/acme/widgets')).toBe(true);
    expect(bundledTemplateMatches(bundledUpper, 'git@github.com:ACME/WIDGETS.git')).toBe(true);
  });

  it('is FALSE for a different GitHub repository (#229 guarantee, one layer up)', () => {
    const mine = bundled('https://github.com/acme/widgets.git');

    expect(bundledTemplateMatches(mine, 'https://github.com/acme/other-repo.git')).toBe(false);
    expect(bundledTemplateMatches(mine, 'https://github.com/another-owner/widgets.git')).toBe(
      false,
    );
  });

  it('compares two non-GitHub URLs literally: equal strings match', () => {
    const other = bundled('https://gitlab.example.test/o/r.git');
    expect(bundledTemplateMatches(other, 'https://gitlab.example.test/o/r.git')).toBe(true);
  });

  it('compares two non-GitHub URLs literally: different strings do not match', () => {
    const other = bundled('https://gitlab.example.test/o/r.git');
    expect(bundledTemplateMatches(other, 'https://gitlab.example.test/o/other.git')).toBe(false);
  });

  it('is false when one side is GitHub and the other is not', () => {
    const github = bundled('https://github.com/acme/widgets.git');
    expect(bundledTemplateMatches(github, 'https://gitlab.example.test/acme/widgets.git')).toBe(
      false,
    );

    const other = bundled('https://gitlab.example.test/acme/widgets.git');
    expect(bundledTemplateMatches(other, 'https://github.com/acme/widgets.git')).toBe(false);
  });
});

describe('bundledTemplateFor', () => {
  it('returns the contents when the bundled template belongs to repoUrl', () => {
    const root = makeRoot();
    writeBundle(root, {
      envContents: 'KEY=value\n',
      sourceJson: { repoUrl: 'https://github.com/acme/widgets', ref: 'main' },
    });

    expect(bundledTemplateFor('https://github.com/acme/widgets.git', root)).toBe('KEY=value\n');
    // A different scheme for the same repository still matches.
    expect(bundledTemplateFor('git@github.com:acme/widgets.git', root)).toBe('KEY=value\n');
  });

  it('is undefined when the bundled template belongs to a different repository', () => {
    const root = makeRoot();
    writeBundle(root, {
      envContents: 'KEY=value\n',
      sourceJson: { repoUrl: 'https://github.com/acme/widgets', ref: 'main' },
    });

    expect(bundledTemplateFor('https://github.com/acme/other-repo.git', root)).toBeUndefined();
  });

  it('is undefined when there is no bundled template at all', () => {
    const root = makeRoot();
    expect(bundledTemplateFor('https://github.com/acme/widgets.git', root)).toBeUndefined();
  });

  it('is undefined for an empty repoUrl, even with a valid bundle present', () => {
    const root = makeRoot();
    writeBundle(root, {
      envContents: 'KEY=value\n',
      sourceJson: { repoUrl: 'https://github.com/acme/widgets', ref: 'main' },
    });

    expect(bundledTemplateFor('', root)).toBeUndefined();
    expect(bundledTemplateFor('   ', root)).toBeUndefined();
  });
});
