import { describe, it, expect } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, resolve, sep } from 'node:path';

/**
 * The five coupled breakpoint gates are the PACKAGE's since #484 (epic #478):
 *
 *   1. `ShellLayout` `showRail`            `up('sm')`
 *   2. `ShellBottomNav` self-gate          `down('sm')`
 *   3. `<main>` `pb: { xs: 10, sm: 3 }`    (in `ShellLayout`)
 *   4. `SettingsHub` `isCompactWindow`     `down('sm')`
 *   5. `ShellAppBar` `isCompactWindow`     `down('sm')`
 *
 * all under `@marinoscar/platform-web` (`shell/ui`, `settings/ui`), which this
 * repository cannot edit. What it CAN do is refuse to grow a sixth read in the
 * shell chrome it binds. This suite scans `apps/web/src` for the two ways a
 * component reads a breakpoint, `useMediaQuery(` and `theme.breakpoints.up|down(`,
 * and fails on any file that is not listed below with a reason. Adding a read is
 * allowed; adding it WITHOUT writing down why it is not a gate is not.
 *
 * It is a text scan, not a parser: block and line comments are stripped first so
 * prose that names `useMediaQuery(` does not count.
 *
 * Rule 5 of the Settings UI Pattern (root AGENTS.md): the boundary is `sm`
 * (600px), never `md`. `LibraryPageFrame.tsx` also reads `down('sm')` and is the
 * documented non-gate.
 *
 * Since #499 (epic #498) `LibraryPageFrame` lives in `@marinoscar/kvox-web`
 * (`packages/kvox-web/src/core/ui/library/`), and the library views will follow it
 * with the domain slices. The scan therefore covers that package's sources too; a
 * file there is keyed `@marinoscar/kvox-web:<path from its src/>`, so the one
 * documented non-gate is still named, and still needs its reason, wherever it lives.
 */

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The domain web package: breakpoint reads that moved there are still scanned. */
const KVOX_WEB_SRC = resolve(SRC, '../../../packages/kvox-web/src');
const KVOX_WEB_KEY = '@marinoscar/kvox-web:';

const BREAKPOINT_READ = /\buseMediaQuery\s*\(|\bbreakpoints\.(?:up|down|between|only)\s*\(/;

/** Why a file may read a breakpoint without being one of the five gates. */
const WHY = {
  libraryFrame:
    'LibraryPageFrame is the documented non-gate: it only decides where one page puts its create action (header button or FAB), never whether app chrome mounts',
  libraryView:
    'a library list chooses a phone card row or a table row for its own content; it mounts no navigation',
  dialog:
    'a dialog or sheet goes full-screen below sm; it is page content, not navigation chrome',
  panel:
    'a page-local side panel or action bar chooses its own compact layout; it is page content, not navigation chrome',
  page: 'a page picks its own compact layout for its body; it is page content, not navigation chrome',
  graph:
    'a knowledge-graph surface picks a compact layout for its own canvas or panel; page content, not navigation chrome',
  explorerShell:
    'the Insight Canvas shell (GIC-08) reads its OWN window class (600 and 1200), input modality and reduced-motion preference inside the page main to place the explorer panes; it mounts no navigation and moves none of the five platform gates',
  datatable:
    'the data table\'s viewport fallback when it cannot measure its container; the table is page content',
} as const;

/**
 * Every file under `src/` (outside tests) that reads a breakpoint, keyed by its
 * path from `src/`. NONE of them may be shell chrome (see `CHROME` below).
 */
const ALLOWED_READS: Readonly<Record<string, string>> = {
  '@marinoscar/kvox-web:core/ui/library/LibraryPageFrame.tsx': WHY.libraryFrame,
  '@marinoscar/kvox-web:transcripts/ui/components/TranscriptsLibraryView.tsx': WHY.libraryView,
  '@marinoscar/kvox-web:notes/ui/components/NotesLibraryView.tsx': WHY.libraryView,

  '@marinoscar/kvox-web:transcripts/ui/components/ExportDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:transcripts/ui/components/NameCheckDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:notes/ui/components/NoteContextDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:notes/ui/components/NoteExportDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:notes/ui/components/NoteConflictDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/ImportGraphDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/ExportGraphDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/EntityEditDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/settings/AttributeDefDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/guide/ExtractDialog.tsx': WHY.dialog,
  '@marinoscar/kvox-web:graph/ui/components/review/ProposalReviewSheet.tsx': WHY.dialog,

  '@marinoscar/kvox-web:transcripts/ui/components/NameSuggestionsPanel.tsx': WHY.panel,
  '@marinoscar/kvox-web:transcripts/ui/components/FindReplacePanel.tsx': WHY.panel,
  '@marinoscar/kvox-web:transcripts/ui/components/SegmentActions.tsx': WHY.panel,
  '@marinoscar/kvox-web:transcripts/ui/components/SpeakerActions.tsx': WHY.panel,
  '@marinoscar/kvox-web:transcripts/ui/components/TranscriptPipeline.tsx': WHY.panel,
  '@marinoscar/kvox-web:ask/ui/components/EntityAskPanel.tsx': WHY.panel,

  '@marinoscar/kvox-web:graph/ui/components/overview/ClusterSidePanel.tsx': WHY.graph,
  '@marinoscar/kvox-web:graph/ui/components/explorer/shell/useWindowClass.ts': WHY.explorerShell,
  '@marinoscar/kvox-web:graph/ui/components/explorer/shell/useInputModality.ts': WHY.explorerShell,
  '@marinoscar/kvox-web:graph/ui/components/explorer/shell/useReducedMotion.ts': WHY.explorerShell,
  '@marinoscar/kvox-web:graph/ui/components/EvidenceChip.tsx': WHY.graph,
  '@marinoscar/kvox-web:graph/ui/components/NeighborhoodWidget.tsx': WHY.graph,
  '@marinoscar/kvox-web:graph/ui/components/EntityHeader.tsx': WHY.graph,
  '@marinoscar/kvox-web:graph/ui/components/selection/GraphSelectionAdd.tsx': WHY.graph,
  '@marinoscar/kvox-web:graph/ui/components/explorer/GraphCanvas.tsx': WHY.graph,

  'components/datatable/desktop/DesktopGridRenderer.tsx': WHY.datatable,
  'components/datatable/useContainerLayout.ts': WHY.datatable,

  '@marinoscar/kvox-web:notes/ui/pages/NewNotePage.tsx': WHY.page,
  '@marinoscar/kvox-web:graph/ui/pages/GraphIndexPage.tsx': WHY.page,
  '@marinoscar/kvox-web:graph/ui/pages/GraphOverviewPage.tsx': WHY.page,
  '@marinoscar/kvox-web:ask/ui/pages/AskPage.tsx': WHY.page,
  // `up('md')`: whether the transcript page lays its player beside the text.
  '@marinoscar/kvox-web:transcripts/ui/pages/TranscriptPage.tsx': WHY.page,
};

/**
 * The files that ARE this app's shell chrome and its bindings. They must read no
 * breakpoint at all: the shell, its settings hub and its themes are the package's.
 */
const CHROME = [
  'App.tsx',
  'main.tsx',
  'components/common/Layout.tsx',
  'config/shell.ts',
  'config/destinations.ts',
  'config/adminSections.tsx',
  'config/userSettingsSections.tsx',
  'config/settingsFeatures.ts',
  'pages/UserSettingsHubPage.tsx',
  'pages/Admin/SettingsHubPage.tsx',
  'platform/platformHost.tsx',
  'platform/GraphFeatureBinding.tsx',
  'theme/index.ts',
];

/** Block and line comments removed (a line comment must not follow `:` or a quote, so URLs survive). */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
}

function isTestFile(path: string): boolean {
  const parts = path.split(sep);
  return (
    parts.includes('__tests__') ||
    /\.(test|spec)\.(ts|tsx)$/.test(path) ||
    parts.includes('mocks')
  );
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !isTestFile(full) ? [full] : [];
  });
}

const FILES = [...sourceFiles(SRC), ...sourceFiles(KVOX_WEB_SRC)];

/** `path from src/`, with the package prefix for a file of `@marinoscar/kvox-web`. */
function keyOf(file: string): string {
  return file.startsWith(KVOX_WEB_SRC + sep)
    ? KVOX_WEB_KEY + relative(KVOX_WEB_SRC, file).split(sep).join('/')
    : relative(SRC, file).split(sep).join('/');
}

const READERS = FILES.filter((file) =>
  BREAKPOINT_READ.test(stripComments(readFileSync(file, 'utf8'))),
).map(keyOf);

describe('breakpoint gates — the five are the package\'s (#484)', () => {
  it('scans the source tree (guards the scan itself against matching nothing)', () => {
    expect(FILES.length).toBeGreaterThan(100);
    // The one documented non-gate must be found, or the scan is not reading code.
    expect(READERS).toContain('@marinoscar/kvox-web:core/ui/library/LibraryPageFrame.tsx');
  });

  it('every file that reads a breakpoint is listed with a reason', () => {
    const unlisted = READERS.filter((file) => !(file in ALLOWED_READS));
    expect(
      unlisted,
      `These files read a breakpoint (useMediaQuery or theme.breakpoints.up/down) and are not ` +
        `listed in ALLOWED_READS. The five coupled gates live in @marinoscar/platform-web ` +
        `(ShellLayout, ShellBottomNav, SettingsHub, ShellAppBar); a new read is a page-level ` +
        `choice that must say why it is not a sixth gate.`,
    ).toEqual([]);
  });

  it('lists no file that has stopped reading a breakpoint (the allowlist stays honest)', () => {
    const stale = Object.keys(ALLOWED_READS).filter((file) => !READERS.includes(file));
    expect(stale, 'Remove these from ALLOWED_READS: they read no breakpoint any more').toEqual([]);
  });

  it('gives every listed read a reason', () => {
    for (const [file, reason] of Object.entries(ALLOWED_READS)) {
      expect(reason.length, `${file} needs a reason`).toBeGreaterThan(20);
    }
  });

  it('keeps LibraryPageFrame the only library-chrome exemption: it is the documented non-gate', () => {
    expect(ALLOWED_READS['@marinoscar/kvox-web:core/ui/library/LibraryPageFrame.tsx']).toBe(
      WHY.libraryFrame,
    );
  });

  describe('shell chrome and its bindings read no breakpoint', () => {
    it.each(CHROME)('%s', (file) => {
      expect(existsSync(join(SRC, file)), `${file} must exist`).toBe(true);
      expect(READERS).not.toContain(file);
      expect(Object.keys(ALLOWED_READS)).not.toContain(file);
    });
  });

  it('keeps the deleted app-side shell files deleted', () => {
    // A re-added copy would bring a second set of gates back.
    for (const gone of [
      'components/navigation/AppBar.tsx',
      'components/navigation/BottomNav.tsx',
      'components/navigation/NavigationRail.tsx',
      'components/navigation/UserMenu.tsx',
      'components/settings/SettingsHub.tsx',
      'contexts/ThemeContext.tsx',
      'contexts/NavigationFeaturesContext.tsx',
      'hooks/useNavigationPrefs.ts',
    ]) {
      expect(existsSync(join(SRC, gone)), `${gone} must stay deleted`).toBe(false);
    }
  });
});
