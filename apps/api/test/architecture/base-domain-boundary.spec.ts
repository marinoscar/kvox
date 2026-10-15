// =============================================================================
// ⚠ BASE CODE DOES NOT IMPORT DOMAIN CODE (issue #459, epic #457)
// =============================================================================
//
// KVox is a platform (auth, RBAC, settings, jobs, storage, notifications, AI
// plumbing, ...) with a product on top (transcription, transcripts, notes, the
// knowledge graph, Ask, search). The platform half is being replaced by
// published packages, one slice at a time, and a published package cannot
// import `apps/api/src/notes/...`. Every edge from a base module INTO a domain
// module is therefore a Phase 1 swap that cannot happen until someone removes
// the edge. #459 removed the ones in `ai/`, `common/` and `settings/`; this
// test is what stops the next one from arriving unnoticed.
//
// -----------------------------------------------------------------------------
// WHY A STRUCTURAL TEST RATHER THAN A REVIEW CONVENTION
// -----------------------------------------------------------------------------
//
// The regression is invisible from inside the file that causes it. Somebody
// needs a token budget, a settings schema or an enum that already exists in
// `notes/`, writes one import line, and everything still compiles, every
// existing test still passes and the feature works. The cost shows up two
// quarters later, when the settings module cannot be lifted out because it
// drags the transcription settings schema along with it. That is the class of
// defect a reviewer catches only if they happen to remember the rule, so the
// rule is executable.
//
// -----------------------------------------------------------------------------
// WHAT IT CHECKS
// -----------------------------------------------------------------------------
//
// BASE DIRECTORIES ARE DERIVED, not listed: every directory directly under
// `apps/api/src` that is not in `DOMAIN_DIRS`. A new base module is covered the
// day it is created, with no edit to this file. Every `.ts` file under one is
// parsed, specs included (a spec that imports domain code is the same edge: it
// cannot move with its slice), together with the loose files directly in
// `apps/api/src` that are not composition roots.
//
// "Imports" is read with the TypeScript compiler API, not a regular expression,
// so a specifier inside a comment or a string is not an edge and no spelling of
// a real one slips past: `import`, `import type`, `export ... from`,
// `import x = require()`, dynamic `import()`, `import('...')` in a type
// position, `require()`, `jest.mock()` and its siblings (a mock of a domain
// module is an import of it), and a `declare module '...'` augmentation of a
// relative path. A relative specifier is resolved against the importing file;
// the edge is a violation when the target lies under `apps/api/src/<domain>/`.
//
// It does not follow re-exports through a barrel: base code importing a base
// barrel that itself re-exports domain code is a violation reported on the
// barrel, which is a base file too.
//
// -----------------------------------------------------------------------------
// WHEN IT FAILS
// -----------------------------------------------------------------------------
//
// The message names the file, the line, the specifier and the domain. Do not
// widen `DOMAIN_DIRS` or add to `ALLOWLIST` to make it pass. The fix is to
// invert the dependency: the domain module registers what the base module needs
// (the settings namespace registry, `kvox.manifest.ts`, is the worked example),
// or the shared piece moves down into base code (the token budget moved from
// `notes/generation/` to `ai/` for this reason). If the piece is a spec that
// needs domain code to run, the spec belongs in the domain folder (see
// `notes/generation/note-generation-request.task-model.spec.ts`), or under
// `test/` if it is genuinely about the composition.
//
// -----------------------------------------------------------------------------
// THE ALLOWLIST: ONLY WHAT ISSUE 0.4 REMOVES, AND IT MUST EMPTY
// -----------------------------------------------------------------------------
//
// `ALLOWLIST` holds exactly the edges that #459 deliberately left for issue
// 0.4 (onboarding, user-data and the note-source job contract). Each entry
// carries a reason and the issue that removes it. An entry that no longer
// matches a real edge FAILS the test ("stale allowlist entry: delete it"), so
// whoever removes an edge cannot forget to remove its entry, and 0.4 finishes
// with an empty list. A new entry needs a pull request that argues for it, which
// is the conversation that should happen.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import * as ts from 'typescript';

/** The API's source root, from this file. */
const SRC = resolve(__dirname, '..', '..', 'src');

/**
 * The product half of the API. Everything else directly under `src/` is base
 * code. Adding a directory here is a decision to NOT enforce the boundary for
 * it, so it is argued in a pull request, not done to silence a failure.
 */
const DOMAIN_DIRS: readonly string[] = [
  'transcription',
  'transcripts',
  'notes',
  'graph',
  'ask',
  'search',
];

/**
 * Loose files in `src/` that are COMPOSITION ROOTS: they exist to know every
 * module, domain included. Each says why in its own header.
 */
const ROOT_FILES_EXEMPT: readonly string[] = [
  'app.module.ts', // imports every feature module, base and domain, to assemble the application
  'main.ts', // the HTTP entry point; imports the manifest and the app module
  'kvox.manifest.ts', // the composition root for static registries (settings namespaces)
  'instrumentation.ts', // OpenTelemetry bootstrap, loaded before everything else
];

interface AllowedEdge {
  /** The importing file, relative to `apps/api/src`, posix separators. */
  readonly from: string;
  /** The imported module, relative to `apps/api/src`, posix, no extension. */
  readonly to: string;
  /** Why the edge exists and why it cannot be removed in #459. */
  readonly reason: string;
  /** The issue that removes it. */
  readonly removedBy: string;
}

/**
 * ⚠ THE REMAINING BASE -> DOMAIN EDGES, ALL OWNED BY ISSUE 0.4.
 * Only that issue may remove entries; nothing may add one without arguing it.
 */
const ALLOWLIST: ReadonlyArray<AllowedEdge> = [
  {
    from: 'jobs/contracts/note-source-extract.contract.ts',
    to: 'notes/extraction/extraction-result',
    reason:
      'The node-eligible note.source.extract job contract (the result schema a worker node validates against) is built from the notes extraction-result constants and types. The contract moves to the domain that owns the job type; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'onboarding/onboarding.module.ts',
    to: 'transcription/transcription.module',
    reason:
      "Onboarding's admin.transcription step reads TranscriptionConfigService.getConfig() to derive whether transcription is available, and the module imports TranscriptionModule to get it. The step catalogue becomes a registry the transcription module contributes to; out of scope for #459.",
    removedBy: 'issue 0.4',
  },
  {
    from: 'onboarding/onboarding.service.ts',
    to: 'transcription/transcription-config.service',
    reason:
      "Onboarding's admin.transcription step reads TranscriptionConfigService.getConfig() to derive whether transcription is available, and the module imports TranscriptionModule to get it. The step catalogue becomes a registry the transcription module contributes to; out of scope for #459.",
    removedBy: 'issue 0.4',
  },
  {
    from: 'onboarding/onboarding.service.spec.ts',
    to: 'transcription/transcription-config.service',
    reason:
      'Spec of the edge above: onboarding.service.spec.ts types its TranscriptionConfigService stand-in with the real class, so it moves with the edge once the step is contributed through a registry.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'graph/job-types',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'notes/job-types',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'notes/note-templates.service',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'notes/notes.service',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'search/indexing/job-types',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'search/indexing/search-index.service',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'transcripts/job-types',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.ts',
    to: 'transcripts/transcript-pipeline.service',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.spec.ts',
    to: 'graph/job-types',
    reason:
      'Spec of the purge handler above: it asserts against the graph, notes and transcripts job type constants (KG_PURGE_JOB_TYPE, NOTE_PURGE_JOB_TYPE, ...) the handler itself imports, so it moves with the edge.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.spec.ts',
    to: 'notes/job-types',
    reason:
      'Spec of the purge handler above: it asserts against the graph, notes and transcripts job type constants (KG_PURGE_JOB_TYPE, NOTE_PURGE_JOB_TYPE, ...) the handler itself imports, so it moves with the edge.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/handlers/user-data-purge.handler.spec.ts',
    to: 'transcripts/job-types',
    reason:
      'Spec of the purge handler above: it asserts against the graph, notes and transcripts job type constants (KG_PURGE_JOB_TYPE, NOTE_PURGE_JOB_TYPE, ...) the handler itself imports, so it moves with the edge.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/user-data.module.ts',
    to: 'notes/notes.module',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/user-data.module.ts',
    to: 'search/indexing/search-indexing.module',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/user-data.module.ts',
    to: 'transcripts/transcripts.module',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/user-data.service.ts',
    to: 'notes/job-types',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
  {
    from: 'user-data/user-data.service.ts',
    to: 'notes/source-metadata',
    reason:
      'The Danger Zone purge fans out to the notes, transcripts, search and graph purge handlers, job types and services by name. It becomes a registry of per-category deleters each domain module registers; out of scope for #459.',
    removedBy: 'issue 0.4',
  },
];

// -----------------------------------------------------------------------------
// Scanning
// -----------------------------------------------------------------------------

/** A module specifier found in a file, with where it was found. */
interface FoundSpecifier {
  readonly specifier: string;
  readonly line: number;
}

const JEST_MODULE_CALLS = new Set([
  'mock',
  'doMock',
  'unmock',
  'dontMock',
  'requireActual',
  'requireMock',
  'createMockFromModule',
  'setMock',
]);

/**
 * Every module specifier a source text refers to, in any spelling.
 * Also what the self-test below exercises directly.
 */
function findSpecifiers(fileName: string, text: string): FoundSpecifier[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const found: FoundSpecifier[] = [];

  const add = (literal: ts.Node | undefined): void => {
    if (literal !== undefined && ts.isStringLiteralLike(literal)) {
      found.push({
        specifier: literal.text,
        line: sourceFile.getLineAndCharacterOfPosition(literal.getStart(sourceFile)).line + 1,
      });
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        add(node.moduleReference.expression);
      }
    } else if (ts.isImportTypeNode(node)) {
      // `typeof import('../notes/x')` / `import('../notes/x').Foo` in a type.
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isModuleDeclaration(node)) {
      // `declare module '../x' { ... }` augmentation.
      if (ts.isStringLiteralLike(node.name)) add(node.name);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(first); // dynamic import('...')
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        add(first);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'jest' &&
        JEST_MODULE_CALLS.has(callee.name.text)
      ) {
        add(first);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'require' &&
        callee.name.text === 'resolve'
      ) {
        add(first);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return found;
}

function posix(path: string): string {
  return path.split(sep).join('/');
}

function walkTypeScript(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) files.push(...walkTypeScript(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(full);
  }
  return files;
}

/** Every directory directly under `src/` that is not a domain directory. */
function deriveBaseDirs(): string[] {
  return readdirSync(SRC)
    .filter((entry) => statSync(join(SRC, entry)).isDirectory())
    .filter((entry) => !DOMAIN_DIRS.includes(entry))
    .sort();
}

/** The files this test holds to the rule: base directories plus non-exempt root files. */
function baseFiles(): string[] {
  const files: string[] = [];
  for (const dir of deriveBaseDirs()) files.push(...walkTypeScript(join(SRC, dir)));
  for (const entry of readdirSync(SRC)) {
    const full = join(SRC, entry);
    if (statSync(full).isFile() && entry.endsWith('.ts') && !ROOT_FILES_EXEMPT.includes(entry)) {
      files.push(full);
    }
  }
  return files.sort();
}

interface Edge {
  readonly from: string;
  readonly line: number;
  readonly specifier: string;
  readonly domain: string;
  /** Resolved target, relative to `src/`, posix, extension-less. */
  readonly to: string;
}

/** The domain a resolved path lies in, or `null` when it lies in none. */
function domainOf(resolved: string): string | null {
  const rel = relative(SRC, resolved);
  if (rel.startsWith('..') || rel === '') return null;
  const [top] = rel.split(sep);
  return DOMAIN_DIRS.includes(top) ? top : null;
}

function edgesIn(file: string, text: string): Edge[] {
  const edges: Edge[] = [];
  for (const { specifier, line } of findSpecifiers(file, text)) {
    if (!specifier.startsWith('.')) continue; // a package, not a project file
    const resolved = resolve(dirname(file), specifier);
    const domain = domainOf(resolved);
    if (domain === null) continue;
    edges.push({
      from: posix(relative(SRC, file)),
      line,
      specifier,
      domain,
      to: posix(relative(SRC, resolved)).replace(/\.(ts|tsx|js)$/, ''),
    });
  }
  return edges;
}

function allEdges(): Edge[] {
  return baseFiles().flatMap((file) => edgesIn(file, readFileSync(file, 'utf8')));
}

const isAllowed = (edge: Edge): boolean =>
  ALLOWLIST.some((entry) => entry.from === edge.from && entry.to === edge.to);

const violationMessage = (edge: Edge): string =>
  `${edge.from}:${edge.line} imports '${edge.specifier}' (domain '${edge.domain}'). ` +
  'Base code may not depend on domain code: add a registry entry the domain module registers ' +
  '(see docs/platform-adoption/module-classification.md).';

// -----------------------------------------------------------------------------
// The tests
// -----------------------------------------------------------------------------

describe('base code does not import domain code (issue #459)', () => {
  it('derives its base directories from src/ and every domain directory still exists', () => {
    const base = deriveBaseDirs();

    // The directories the rule exists for are covered...
    expect(base).toEqual(expect.arrayContaining(['ai', 'common', 'settings', 'jobs', 'onboarding', 'user-data']));
    // ...none of the product directories is mistaken for base...
    for (const domain of DOMAIN_DIRS) expect(base).not.toContain(domain);
    // ...and a renamed or deleted domain directory fails here instead of
    // silently turning into "no domain, so no rule".
    for (const domain of DOMAIN_DIRS) {
      expect({ domain, exists: statSync(join(SRC, domain)).isDirectory() }).toEqual({ domain, exists: true });
    }
  });

  it('scans a meaningful number of files', () => {
    // A path mistake (a wrong SRC) would make every other case vacuously green.
    expect(baseFiles().length).toBeGreaterThan(200);
  });

  it('lists only composition roots that exist', () => {
    for (const file of ROOT_FILES_EXEMPT) {
      expect({ file, exists: statSync(join(SRC, file)).isFile() }).toEqual({ file, exists: true });
    }
  });

  it('has no base -> domain import outside the allowlist', () => {
    const violations = allEdges().filter((edge) => !isAllowed(edge)).map(violationMessage);

    expect(violations).toEqual([]);
  });

  it('has no stale allowlist entry', () => {
    const edges = allEdges();
    const stale = ALLOWLIST.filter(
      (entry) => !edges.some((edge) => edge.from === entry.from && edge.to === entry.to),
    ).map(
      (entry) =>
        `stale allowlist entry: delete it (${entry.from} -> ${entry.to} no longer exists; removedBy ${entry.removedBy}).`,
    );

    expect(stale).toEqual([]);
  });

  it('argues every allowlist entry and attributes it to the issue that removes it', () => {
    for (const entry of ALLOWLIST) {
      expect({ entry: `${entry.from} -> ${entry.to}`, reason: entry.reason.trim().length > 20 }).toEqual({
        entry: `${entry.from} -> ${entry.to}`,
        reason: true,
      });
      expect({ entry: `${entry.from} -> ${entry.to}`, removedBy: entry.removedBy }).toEqual({
        entry: `${entry.from} -> ${entry.to}`,
        removedBy: 'issue 0.4',
      });
      // The allowlist is for base files; a domain -> domain edge is not its business.
      expect(DOMAIN_DIRS.includes(entry.from.split('/')[0])).toBe(false);
    }
  });

  it('lists each allowlist entry once', () => {
    const keys = ALLOWLIST.map((entry) => `${entry.from} -> ${entry.to}`);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

// -----------------------------------------------------------------------------
// The scanner itself: every spelling of an import is seen, and nothing else is
// -----------------------------------------------------------------------------

describe('the import scanner', () => {
  const FILE = join(SRC, 'ai', 'example.ts');
  const specifiers = (text: string) => findSpecifiers(FILE, text).map((found) => found.specifier);

  it.each([
    ['a named import', "import { X } from '../notes/notes.service';"],
    ['a default import', "import X from '../notes/notes.service';"],
    ['a namespace import', "import * as X from '../notes/notes.service';"],
    ['a type-only import', "import type { X } from '../notes/notes.service';"],
    ['a side-effect import', "import '../notes/notes.service';"],
    ['a re-export', "export { X } from '../notes/notes.service';"],
    ['a star re-export', "export * from '../notes/notes.service';"],
    ['an import-equals', "import X = require('../notes/notes.service');"],
    ['a dynamic import', "const m = await import('../notes/notes.service');"],
    ['a require call', "const m = require('../notes/notes.service');"],
    ['an import type in a type position', "type T = typeof import('../notes/notes.service');"],
    ['a jest.mock', "jest.mock('../notes/notes.service');"],
    ['a jest.mock with a factory', "jest.mock('../notes/notes.service', () => ({}));"],
    ['a jest.requireActual', "const a = jest.requireActual('../notes/notes.service');"],
    ['a module augmentation', "declare module '../notes/notes.service' { interface X {} }"],
  ])('sees %s', (_name, text) => {
    expect(specifiers(text)).toEqual(['../notes/notes.service']);
  });

  it('does not see a specifier that is only in a comment or an ordinary string', () => {
    const text = [
      "// import { X } from '../notes/notes.service';",
      "/* jest.mock('../notes/notes.service'); */",
      "const s = \"import { X } from '../notes/notes.service'\";",
      "const t = `require('../notes/notes.service')`;",
    ].join('\n');

    expect(specifiers(text)).toEqual([]);
  });

  it('reports the line of the specifier', () => {
    const text = ["import a from './a';", '', "import b from '../notes/b';"].join('\n');

    expect(findSpecifiers(FILE, text)).toEqual([
      { specifier: './a', line: 1 },
      { specifier: '../notes/b', line: 3 },
    ]);
  });

  it('resolves a relative specifier against the importing file and ignores packages', () => {
    const text = [
      "import { Injectable } from '@nestjs/common';",
      "import { a } from './ai-token-budget';",
      "import { b } from '../common/registry';",
      "import { c } from '../notes/notes.service';",
      "import { d } from '../../test/helpers/ai-task-model.fixtures';",
      "import { e } from '../graph';",
    ].join('\n');

    expect(edgesIn(FILE, text).map((edge) => [edge.line, edge.domain, edge.to])).toEqual([
      [4, 'notes', 'notes/notes.service'],
      [6, 'graph', 'graph'],
    ]);
  });
});
