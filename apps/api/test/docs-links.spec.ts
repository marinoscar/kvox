import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative } from 'node:path';

// =============================================================================
// Every relative link in the repo-level documentation resolves to a real file
// (issue #335)
// =============================================================================
//
// Three markdown links survived for an unknown length of time pointing at
// files that were never written (docs/specs/settings-ui.md,
// docs/specs/api-documentation.md, docs/System_Specification_Document.md),
// referenced from CLAUDE.md, ARCHITECTURE.md, API.md, DEVELOPMENT.md,
// DEVICE-AUTH.md, README.md and .claude/agents/docs-dev.md. Nothing checked,
// so nothing noticed — this is that check.
//
// WHAT THIS SCANS: README.md, CLAUDE.md and CHANGELOG.md at the repo root,
// every `.md` file under `docs/` (recursively), and every `.md` file directly
// under `.claude/agents/` (cheap to include, and it is a real source of
// prose — see docs-dev.md, the docs subagent's own instructions, which is
// exactly where the fourth `System_Specification_Document.md` reference hid).
//
// WHAT THIS DOES NOT DO: fetch a URL, or understand Markdown beyond fenced
// code blocks and link syntax. A relative link is resolved against the
// CONTAINING FILE's own directory (the same rule every Markdown renderer and
// GitHub itself use) and checked for existence with `fs.existsSync` — nothing
// heavier. `http(s)://` and `mailto:` targets, and pure in-page anchors
// (`#foo`), are skipped entirely: neither is this test's job. A target
// carrying its own `#anchor` (`specs/job-queue.md#3-the-terminal-state-machine`)
// has that anchor stripped before resolution — this checks that the FILE
// exists, not that the heading inside it still does.
//
// FENCED CODE BLOCKS ARE STRIPPED FIRST, line-for-line (blanked, not
// deleted, so line numbers in a failure message still point at the right
// line of the original file) — `.claude/agents/docs-dev.md` contains a whole
// EXAMPLE README.md, fenced, with its own `docs/SECURITY.md` and
// `docs/OBSERVABILITY.md` links that describe a generic project structure
// and were never meant to resolve against this repository. Scanning the
// fence would make this test permanently red over documentation ABOUT
// documentation, which is a worse failure mode than the bug it exists to
// catch.
// =============================================================================

const REPO_ROOT = resolve(__dirname, '..', '..', '..');

interface DocLink {
  /** Path to the containing file, relative to the repo root, for the failure message. */
  file: string;
  /** 1-based line number within that file. */
  line: number;
  /** The link target exactly as written, before anchor-stripping. */
  target: string;
}

/** Every `.md` file directly inside `dir` (non-recursive) that exists. */
function markdownFilesIn(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => join(dir, entry.name));
}

/** Every `.md` file under `dir`, recursively. */
function markdownFilesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...markdownFilesUnder(full));
    } else if (entry.name.endsWith('.md')) {
      found.push(full);
    }
  }

  return found;
}

/** The full set of files this guard scans, repo-root-relative order-independent. */
function scannedFiles(): string[] {
  const files: string[] = [];

  for (const name of ['README.md', 'CLAUDE.md', 'CHANGELOG.md']) {
    const path = join(REPO_ROOT, name);
    if (existsSync(path)) files.push(path);
  }

  files.push(...markdownFilesUnder(join(REPO_ROOT, 'docs')));
  // Non-recursive: only the agent definitions themselves, not some future
  // nested directory of unrelated material under .claude/agents/.
  files.push(...markdownFilesIn(join(REPO_ROOT, '.claude', 'agents')));

  return files;
}

/**
 * Blanks every fenced code block (``` ... ```), preserving line count and
 * every non-fence line untouched, so a link inside an example fence can never
 * be mistaken for a real one and every surviving line number still points at
 * the original source line.
 */
function stripFences(text: string): string {
  const lines = text.split('\n');
  let inFence = false;

  return lines
    .map((line) => {
      const isFenceDelimiter = /^\s*```/.test(line);
      if (isFenceDelimiter) {
        inFence = !inFence;
        return '';
      }
      return inFence ? '' : line;
    })
    .join('\n');
}

/** `[text](target)` links found on each line, in order. Reference-style links and bare autolinks are out of scope — none are used in this documentation set. */
const LINK_PATTERN = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

function extractLinks(file: string): DocLink[] {
  const raw = readFileSync(file, 'utf8');
  const stripped = stripFences(raw);
  const relFile = relative(REPO_ROOT, file);
  const links: DocLink[] = [];

  stripped.split('\n').forEach((lineText, index) => {
    for (const match of lineText.matchAll(LINK_PATTERN)) {
      links.push({ file: relFile, line: index + 1, target: match[1] });
    }
  });

  return links;
}

/** Is this target something this guard has no business checking? */
function isOutOfScope(target: string): boolean {
  if (target.startsWith('#')) return true; // pure in-page anchor
  return /^[a-z][a-z0-9+.-]*:/i.test(target); // any URI scheme: http:, https:, mailto:, ...
}

/** Strip a trailing `#anchor`, then resolve against the containing file's own directory. */
function resolveTarget(containingFile: string, target: string): string {
  const withoutAnchor = target.split('#')[0];
  return resolve(dirname(join(REPO_ROOT, containingFile)), withoutAnchor);
}

function targetExists(resolved: string): boolean {
  try {
    // A link to a directory (e.g. `docs/specs/`) is valid too.
    statSync(resolved);
    return true;
  } catch {
    return false;
  }
}

describe('repo-level documentation links resolve (#335)', () => {
  const files = scannedFiles();
  const allLinks = files.flatMap(extractLinks);
  const relativeLinks = allLinks.filter((link) => !isOutOfScope(link.target));

  it('scanned a non-trivial set of files', () => {
    // If this is small, the file-discovery logic above is broken (wrong
    // root, wrong extension filter) rather than the repo suddenly having
    // almost no documentation.
    expect(files.length).toBeGreaterThanOrEqual(20);
  });

  it('found a meaningful number of links to check', () => {
    // The self-check the brief for #335 asked for: a broken LINK_PATTERN
    // (an over-escaped bracket, a swapped capture group) that matched
    // nothing would otherwise leave every file below passing vacuously.
    // This repo's docs carry a little over 100 relative links today (and
    // roughly 190 links total, once absolute URLs and in-page anchors are
    // included); a regression that stops finding most of them should fail
    // here, not slip through a suite that reports 0 problems because it
    // looked at 0 links. The threshold is well under the current count so
    // routine doc edits do not make this test flaky.
    expect(relativeLinks.length).toBeGreaterThanOrEqual(80);
  });

  it('resolves every relative link to a real file or directory', () => {
    const broken = relativeLinks
      .map((link) => ({ link, resolved: resolveTarget(link.file, link.target) }))
      .filter(({ resolved }) => !targetExists(resolved));

    const offenders = broken.map(
      ({ link, resolved }) =>
        `${link.file}:${link.line} -> "${link.target}" (resolved: ${relative(REPO_ROOT, resolved)})`,
    );

    expect(offenders).toEqual([]);
  });
});
