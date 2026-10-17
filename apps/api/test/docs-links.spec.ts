import { mkdirSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
// Since #456 it also scans the package READMEs (`packages/*/README.md` and
// every `README.md` under `packages/*/src/`, skipping `node_modules/`,
// `dist/` and the generated `docs-api/`) and the AI-assistant instruction
// files that two tools load: the root `AGENTS.md`, every nested `AGENTS.md` /
// `CLAUDE.md` under `apps/*` and `packages/*`, `.opencode/agents/*.md` and
// every `.md` under `.claude/skills/`. A broken link there costs a
// small-context model a wasted read, so it is checked too.
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
// line of the original file) — a fenced example (a sample command, a sample
// link in a "how to write docs" snippet) describes a generic project and was
// never meant to resolve against this repository. Scanning the fence would
// make this test permanently red over documentation ABOUT documentation,
// which is a worse failure mode than the bug it exists to catch.
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

/** Directories never descended into: dependencies, build output, generated API reference. */
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'docs-api']);

/** Every `.md` file under `dir` (or only those named `onlyName`), recursively. */
function markdownFilesUnder(dir: string, onlyName?: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];

  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) found.push(...markdownFilesUnder(full, onlyName));
    } else if (onlyName ? entry.name === onlyName : entry.name.endsWith('.md')) {
      found.push(full);
    }
  }

  return found;
}

/** `packages/*\/README.md` and every `README.md` under `packages/*\/src/`. */
function packageReadmes(root: string): string[] {
  const packagesDir = join(root, 'packages');
  if (!existsSync(packagesDir)) return [];
  const found: string[] = [];

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const readme = join(packagesDir, entry.name, 'README.md');
    if (existsSync(readme)) found.push(readme);
    found.push(...markdownFilesUnder(join(packagesDir, entry.name, 'src'), 'README.md'));
  }

  return found;
}

/** Every `README.md` under `examples/` (the reference hosts the guides quote, #506). */
function exampleReadmes(root: string): string[] {
  return markdownFilesUnder(join(root, 'examples'), 'README.md');
}

/** Nested `AGENTS.md` / `CLAUDE.md` directly inside each `apps/*` and `packages/*` directory. */
function nestedAssistantFiles(root: string): string[] {
  const found: string[] = [];
  for (const group of ['apps', 'packages']) {
    const groupDir = join(root, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir, { withFileTypes: true })) {
      if (!entry.isDirectory() || SKIPPED_DIRS.has(entry.name)) continue;
      for (const name of ['AGENTS.md', 'CLAUDE.md']) {
        const path = join(groupDir, entry.name, name);
        if (existsSync(path)) found.push(path);
      }
    }
  }
  return found;
}

/** AI-assistant instruction files (#456): AGENTS.md files, OpenCode agents, Claude skills. */
function assistantConfigFiles(root: string): string[] {
  const files: string[] = [];
  const rootAgents = join(root, 'AGENTS.md');
  if (existsSync(rootAgents)) files.push(rootAgents);
  files.push(...nestedAssistantFiles(root));
  files.push(...markdownFilesIn(join(root, '.opencode', 'agents')));
  files.push(...markdownFilesUnder(join(root, '.claude', 'skills')));
  return files;
}

/** The full set of files this guard scans, repo-root-relative order-independent. */
function scannedFiles(root: string = REPO_ROOT): string[] {
  const files: string[] = [];

  for (const name of ['README.md', 'CLAUDE.md', 'CHANGELOG.md']) {
    const path = join(root, name);
    if (existsSync(path)) files.push(path);
  }

  files.push(...markdownFilesUnder(join(root, 'docs')));
  // Non-recursive: only the agent definitions themselves, not some future
  // nested directory of unrelated material under .claude/agents/.
  files.push(...markdownFilesIn(join(root, '.claude', 'agents')));
  files.push(...packageReadmes(root));
  files.push(...exampleReadmes(root));
  files.push(...assistantConfigFiles(root));

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

function extractLinks(file: string, root: string = REPO_ROOT): DocLink[] {
  const raw = readFileSync(file, 'utf8');
  const stripped = stripFences(raw);
  const relFile = relative(root, file);
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
function resolveTarget(containingFile: string, target: string, root: string = REPO_ROOT): string {
  const withoutAnchor = target.split('#')[0];
  return resolve(dirname(join(root, containingFile)), withoutAnchor);
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

/** `file:line -> "target"` for every relative link under `root` that resolves to nothing. */
function brokenLinks(root: string = REPO_ROOT): string[] {
  return scannedFiles(root)
    .flatMap((file) => extractLinks(file, root))
    .filter((link) => !isOutOfScope(link.target))
    .map((link) => ({ link, resolved: resolveTarget(link.file, link.target, root) }))
    .filter(({ resolved }) => !targetExists(resolved))
    .map(
      ({ link, resolved }) =>
        `${link.file}:${link.line} -> "${link.target}" (resolved: ${relative(root, resolved)})`,
    );
}

describe('repo-level documentation links resolve (#335)', () => {
  const files = scannedFiles();
  const allLinks = files.flatMap((file) => extractLinks(file));
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
    expect(brokenLinks()).toEqual([]);
  });

  it('scans the AI-assistant instruction files (#456)', () => {
    const scanned = files.map((file) => relative(REPO_ROOT, file).split('\\').join('/'));
    for (const expected of ['AGENTS.md', 'apps/api/AGENTS.md', '.opencode/agents/backend-dev.md', '.claude/skills/new-project/SKILL.md']) {
      expect(scanned).toContain(expected);
    }
  });

  it('scans the consumer guides and the reference host README (#506)', () => {
    const scanned = files.map((file) => relative(REPO_ROOT, file).split('\\').join('/'));
    for (const expected of ['docs/guides/README.md', 'docs/guides/kvox-desktop.md', 'examples/bare-host/README.md']) {
      expect(scanned).toContain(expected);
    }
  });

  it('links the KVox Desktop guide from every kvox package README (#506)', () => {
    const missing = readdirSync(join(REPO_ROOT, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('kvox-'))
      .map((entry) => join('packages', entry.name, 'README.md'))
      .filter((readme) => {
        const links = extractLinks(join(REPO_ROOT, readme)).map((link) => resolveTarget(link.file, link.target));
        return !links.includes(join(REPO_ROOT, 'docs', 'guides', 'kvox-desktop.md'));
      });
    expect(missing).toEqual([]);
  });

  it('fails on a broken link in AGENTS.md, a nested CLAUDE.md, an OpenCode agent or a skill (#456)', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-links-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('docs/real.md', '# Real\n');
      write('AGENTS.md', '[ok](docs/real.md)\n[gone](docs/gone.md)\n');
      write('apps/x/CLAUDE.md', '[gone](../../docs/gone2.md)\n');
      write('apps/x/node_modules/AGENTS.md', '[skipped](nowhere.md)\n');
      write('.opencode/agents/a.md', '```\n[fenced](nowhere.md)\n```\n[gone](../../docs/gone3.md)\n');
      write('.claude/skills/s/SKILL.md', '[gone](../../../docs/gone4.md)\n');

      expect(brokenLinks(root)).toEqual([
        'AGENTS.md:2 -> "docs/gone.md" (resolved: docs/gone.md)',
        'apps/x/CLAUDE.md:1 -> "../../docs/gone2.md" (resolved: docs/gone2.md)',
        '.opencode/agents/a.md:4 -> "../../docs/gone3.md" (resolved: docs/gone3.md)',
        '.claude/skills/s/SKILL.md:1 -> "../../../docs/gone4.md" (resolved: docs/gone4.md)',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails on a broken link in a package or slice README, but not in node_modules, dist or docs-api (#456)', () => {
    const root = mkdtempSync(join(tmpdir(), 'docs-links-'));
    try {
      const write = (path: string, text: string) => {
        mkdirSync(dirname(join(root, path)), { recursive: true });
        writeFileSync(join(root, path), text);
      };
      write('docs/real.md', '# Real\n');
      write('packages/pkg-x/README.md', '# X\n\n[ok](../../docs/real.md)\n[gone](../../docs/gone.md)\n');
      write('packages/pkg-x/src/slice/README.md', '# Slice\n\n```md\n[fenced](nowhere.md)\n```\n[gone](../../../../docs/missing.md#anchor)\n');
      write('packages/pkg-x/node_modules/dep/README.md', '[skipped](nowhere.md)\n');
      write('packages/pkg-x/dist/README.md', '[skipped](nowhere.md)\n');
      write('packages/pkg-x/src/slice/docs-api/README.md', '[skipped](nowhere.md)\n');

      expect(brokenLinks(root)).toEqual([
        'packages/pkg-x/README.md:4 -> "../../docs/gone.md" (resolved: docs/gone.md)',
        'packages/pkg-x/src/slice/README.md:6 -> "../../../../docs/missing.md#anchor" (resolved: docs/missing.md)',
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
