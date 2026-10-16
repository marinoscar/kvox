// =============================================================================
// THE AI PORT BOUNDARY (issue #475, epic #472)
// =============================================================================
//
// `KvoxAi` (`src/ai-port/`) is the only way this app's code reaches a model. Two
// rules keep it that way, and both are invisible from inside the file that breaks
// them (one import line compiles, passes every test and works), so they are
// executable:
//
//   1. No file under `src/` outside `ai-port/` and `platform/ai/` imports the
//      platform AI package (`@marinoscar/platform-api/ai`). A feature that does
//      holds a platform type, so the port stops being the seam it is meant to be
//      and the later extraction of the port into its own package breaks.
//   2. No file outside `src/ai/` (in `src/` or `test/`) imports from `src/ai/`, the
//      retired provider module that issue #477 deletes. A new edge into it is a file
//      #477 cannot delete.
//
// "Imports" is read with the TypeScript compiler API, not a regular expression, so
// a specifier inside a comment or a string is not an edge and no spelling of a real
// one slips past: `import`, `import type`, `export ... from`, `import x =
// require()`, dynamic `import()`, `import('...')` in a type position, `require()`,
// `jest.mock()` and its siblings (a mock of a module is an import of it).
//
// WHEN IT FAILS. The message names the file, the line and the specifier. Do not add
// to an allowlist to make it pass. Call the model through `KVOX_AI`
// (`@Inject(KVOX_AI) private readonly ai: KvoxAi`); in a spec, provide the
// `FakeKvoxAi` from `src/ai-port/testing/fake-kvox-ai.ts`.
// =============================================================================

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

const SRC = resolve(__dirname, '../../src');
const TEST = resolve(__dirname, '..');

/** The platform AI package, as a specifier. */
const PLATFORM_AI = '@marinoscar/platform-api/ai';

/** Directories (under `src/`) that may import the platform AI package. */
const PLATFORM_AI_HOMES = ['ai-port/', 'platform/ai/'];

/**
 * Files that import the platform AI package for a reason that is not a call:
 * declaring a registration the platform reads before it composes. Each is a
 * manifest, not a feature. Do not add a feature file here.
 */
const PLATFORM_AI_REGISTRATIONS: Readonly<Record<string, string>> = {
  'app-registrations/ai.ts': 'registerAiFeature: the platform feature registry',
  'app-registrations/settings.ts': 'the extended `ai` settings namespace declaration',
  'platform/credentials/credential-purposes.manifest.ts': 'the AI credential purposes',
};

/**
 * Files outside `src/ai/` that still import from it, each with the issue that
 * removes the edge. The list only shrinks. Keys are relative to `src/` for source
 * files and `test/...` for test files.
 */
const LEGACY_AI_IMPORTERS: Readonly<Record<string, string>> = {
  'app.module.ts': '#477: mounts the old module until it is deleted',
  'ask/ask.module.ts': '#476: the Ask tool loop',
  'ask/ask-history.ts': '#476: the Ask tool loop',
  'ask/handlers/ask-respond.handler.ts': '#476: the Ask tool loop',
  'ask/handlers/ask-respond.handler.spec.ts': '#476: the Ask tool loop',
  'ask/tools/ask-tool.ts': '#476: the Ask tool loop',
  'ask/tools/ask-toolset.ts': '#476: the Ask tool loop',
  'ask/tools/ask-toolset.spec.ts': '#476: the Ask tool loop',
  'test/ask/ask-respond.db.spec.ts': '#476: drives the Ask tool loop through the old chat events',
  'test/ai/ai-settings.integration.spec.ts': '#477: tests the old module; deleted with it',
  'test/ai/ai-credentials.integration.spec.ts': '#477: tests the old module; deleted with it',
  'test/helpers/ai-task-model.fixtures.ts': '#477: fixtures of the old resolver; deleted with it',
};

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

interface FoundSpecifier {
  specifier: string;
  line: number;
}

/** Every module specifier a source text refers to, in any spelling. */
function findSpecifiers(fileName: string, text: string): FoundSpecifier[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    text,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
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
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      add(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) add(node.moduleReference.expression);
    } else if (ts.isImportTypeNode(node)) {
      if (ts.isLiteralTypeNode(node.argument)) add(node.argument.literal);
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const first = node.arguments[0];
      if (callee.kind === ts.SyntaxKind.ImportKeyword) {
        add(first);
      } else if (ts.isIdentifier(callee) && callee.text === 'require') {
        add(first);
      } else if (
        ts.isPropertyAccessExpression(callee) &&
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === 'jest' &&
        JEST_MODULE_CALLS.has(callee.name.text)
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

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) files.push(full);
  }
  return files;
}

interface Edge {
  /** `src/`-relative for source files, `test/...` for test files. */
  file: string;
  /** Absolute directory of the file, which relative specifiers resolve against. */
  dir: string;
  specifier: string;
  line: number;
}

/** Every `src/` and `test/` file with the specifiers it refers to. */
function sourceEdges(): Edge[] {
  const edges: Edge[] = [];
  const roots: Array<{ root: string; key: (full: string) => string }> = [
    { root: SRC, key: (full) => posix(relative(SRC, full)) },
    { root: TEST, key: (full) => `test/${posix(relative(TEST, full))}` },
  ];
  for (const { root, key } of roots) {
    for (const full of walk(root)) {
      const text = readFileSync(full, 'utf8');
      for (const found of findSpecifiers(full, text)) {
        edges.push({ file: key(full), dir: dirname(full), ...found });
      }
    }
  }
  return edges;
}

/** True when a relative `specifier` written in a file of `dir` lands inside `src/ai/` (not `src/ai-port/`). */
function landsInLegacyAi(dir: string, specifier: string): boolean {
  if (!specifier.startsWith('.')) return false;
  const target = posix(relative(SRC, resolve(dir, specifier)));
  return target === 'ai' || target.startsWith('ai/');
}

describe('the AI port boundary (#475)', () => {
  const edges = sourceEdges();

  it('only ai-port/ and platform/ai/ (and the registration manifests) import the platform AI package', () => {
    const violations = edges
      .filter(({ file }) => !file.startsWith('test/'))
      .filter(({ specifier }) => specifier === PLATFORM_AI || specifier.startsWith(`${PLATFORM_AI}/`))
      .filter(({ file }) => !PLATFORM_AI_HOMES.some((home) => file.startsWith(home)))
      .filter(({ file }) => !(file in PLATFORM_AI_REGISTRATIONS))
      .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

    expect(violations).toEqual([]);
  });

  it('nothing outside src/ai/ imports from src/ai/ (except the listed legacy edges)', () => {
    const violations = edges
      .filter(({ file }) => !file.startsWith('ai/'))
      .filter(({ dir, specifier }) => landsInLegacyAi(dir, specifier))
      .filter(({ file }) => !(file in LEGACY_AI_IMPORTERS))
      .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

    expect(violations).toEqual([]);
  });

  it('every legacy allowlist entry is still needed (the list only shrinks)', () => {
    const stillImporting = new Set(
      edges
        .filter(({ file }) => !file.startsWith('ai/'))
        .filter(({ dir, specifier }) => landsInLegacyAi(dir, specifier))
        .map(({ file }) => file),
    );

    const stale = Object.keys(LEGACY_AI_IMPORTERS).filter((file) => !stillImporting.has(file));
    expect(stale).toEqual([]);
  });

  it('every registration allowlist entry still imports the platform AI package', () => {
    const importing = new Set(
      edges
        .filter(({ file }) => !file.startsWith('test/'))
        .filter(({ specifier }) => specifier.startsWith(PLATFORM_AI))
        .map(({ file }) => file),
    );

    const stale = Object.keys(PLATFORM_AI_REGISTRATIONS).filter((file) => !importing.has(file));
    expect(stale).toEqual([]);
  });

  describe('the import reader', () => {
    it('sees every spelling of an import and ignores comments and strings', () => {
      const text = [
        "import a from '../ai/a';",
        "import type { B } from '../ai/b';",
        "export { c } from '../ai/c';",
        "import d = require('../ai/d');",
        "const e = await import('../ai/e');",
        "const f = require('../ai/f');",
        "jest.mock('../ai/g');",
        "type H = import('../ai/h').H;",
        "// import x from '../ai/comment';",
        "const s = \"import y from '../ai/string'\";",
      ].join('\n');

      expect(findSpecifiers('x.ts', text).map((found) => found.specifier)).toEqual([
        '../ai/a',
        '../ai/b',
        '../ai/c',
        '../ai/d',
        '../ai/e',
        '../ai/f',
        '../ai/g',
        '../ai/h',
      ]);
    });

    it('separates src/ai/ from src/ai-port/', () => {
      const dir = (path: string) => resolve(SRC, path);
      expect(landsInLegacyAi(dir('notes'), '../ai/ai-errors')).toBe(true);
      expect(landsInLegacyAi(dir('notes'), '../ai-port/ai-errors')).toBe(false);
      expect(landsInLegacyAi(dir('notes/generation'), '../../ai/providers/p')).toBe(true);
      expect(landsInLegacyAi(dir('notes'), '@nestjs/common')).toBe(false);
      expect(landsInLegacyAi(resolve(TEST, 'helpers'), '../../src/ai/ai-errors')).toBe(true);
      expect(landsInLegacyAi(resolve(TEST, 'helpers'), '../../src/ai-port/ai-errors')).toBe(false);
    });
  });
});
