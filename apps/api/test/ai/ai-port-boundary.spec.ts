// =============================================================================
// THE AI PORT BOUNDARY (issue #475, epic #472)
// =============================================================================
//
// `KVOX_AI` (the port of `@marinoscar/kvox-api/ports`, bound in `src/platform-kvox/` to
// `createKvoxAi` over the runtime in `src/ai-port/`) is the only way this app's code reaches a model. Three
// rules keep it that way, and each is invisible from inside the file that breaks
// it (one import line compiles, passes every test and works), so they are
// executable:
//
//   1. No file under `src/` outside `ai-port/` and `platform/ai/` imports the
//      platform AI package (`@marinoscar/platform-api/ai`). A feature that does
//      holds a platform type, so the port stops being the seam it is meant to be
//      and the later extraction of the port into its own package breaks. Two named
//      kinds of file are exempt: the registration manifests, and the adapters that
//      bind a port another platform slice asks for (the telemetry assistant).
//   2. `src/ai/` does not exist. It was the retired provider module (a hand-written
//      OpenAI client, the per-user credential store, the settings service); issue #477
//      deleted it, and the platform AI slice replaced it.
//   3. Nothing in `src/` or `test/` imports from a `src/ai/` path. With the folder gone
//      this is what stops it coming back by a stray `mkdir`, and it has no allowlist.
//   4. The model mechanics that left `ai-port/` for `@marinoscar/kvox-ai` (#579:
//      strict structured output, the chat mapping, the task chooser, token counts, the
//      embedding catalog, the error translation and the port itself, `createKvoxAi`) make `packages/kvox-ai/src/` the one other home of the
//      platform AI package, on a tighter rule than `ai-port/`: it imports exactly the
//      public subpath `@marinoscar/platform-api/ai` (no other platform subpath, no
//      deeper path), and no Nest, no Prisma and no `@app/shared`, because KVox Desktop
//      installs it without the platform's runtime. `npm run check:kvox-slice-peers`
//      (rule `host-neutral`) enforces the platform half for the package; this spec
//      states it from the app's side, next to the rule it extends.
//
// "Imports" is read with the TypeScript compiler API, not a regular expression, so
// a specifier inside a comment or a string is not an edge and no spelling of a real
// one slips past: `import`, `import type`, `export ... from`, `import x =
// require()`, dynamic `import()`, `import('...')` in a type position, `require()`,
// `jest.mock()` and its siblings (a mock of a module is an import of it).
//
// WHEN IT FAILS. The message names the file, the line and the specifier. Do not add
// to an allowlist to make it pass. Call the model through `KVOX_AI`
// (`@Inject(KVOX_AI) private readonly ai: KvoxAiPort`, `@marinoscar/kvox-api/ports`); in a spec,
// provide `createFakeKvoxAi` of `@marinoscar/kvox-api/testing`, or drive the real binding over a
// scripted `AiService` (`test/helpers/web-kvox-ai.helper.ts`).
// =============================================================================

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

import * as ts from 'typescript';

const SRC = resolve(__dirname, '../../src');
const TEST = resolve(__dirname, '..');

/** The platform AI package, as a specifier. */
const PLATFORM_AI = '@marinoscar/platform-api/ai';

/** Directories (under `src/`) that may import the platform AI package. */
const PLATFORM_AI_HOMES = ['ai-port/', 'platform/ai/'];

/** The package the model mechanics moved to (#579): the other home of the platform AI package (rule 4). */
const KVOX_AI_PACKAGE_SRC = resolve(__dirname, '../../../../packages/kvox-ai/src');

/** What `packages/kvox-ai/src/` may never import (rule 4), besides any platform specifier but {@link PLATFORM_AI}. */
const KVOX_AI_PACKAGE_FORBIDDEN = [/^@nestjs\//, /^@prisma\//, /^prisma$/, /^@app\/shared(\/|$)/];

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
 * Files that import the platform AI package to BIND A PORT another platform slice asks the
 * application for, not to call a model for a feature of this app: the telemetry assistant spends
 * the calling user's own key through `AiService.forUser`, exactly as the slice's README prescribes.
 * Each is an adapter with no prompt of its own. Do not add a feature file here.
 */
const PLATFORM_AI_PORT_BINDINGS: Readonly<Record<string, string>> = {
  'platform/telemetry/telemetry-ai.adapter.ts': 'the telemetry slice\'s AI port, bound over AiService (#471, bound in #477)',
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

/** True when a relative `specifier` written in a file of `dir` lands inside a `src/ai/` path (not `src/ai-port/`). */
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
      .filter(({ file }) => !(file in PLATFORM_AI_PORT_BINDINGS))
      .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

    expect(violations).toEqual([]);
  });

  it('src/ai/ does not exist (the retired provider module is gone, #477)', () => {
    expect(existsSync(join(SRC, 'ai'))).toBe(false);
  });

  it('nothing imports from a src/ai/ path', () => {
    const violations = edges
      .filter(({ dir, specifier }) => landsInLegacyAi(dir, specifier))
      .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

    expect(violations).toEqual([]);
  });

  it('every port-binding allowlist entry still imports the platform AI package', () => {
    const importing = new Set(
      edges
        .filter(({ file }) => !file.startsWith('test/'))
        .filter(({ specifier }) => specifier.startsWith(PLATFORM_AI))
        .map(({ file }) => file),
    );

    expect(Object.keys(PLATFORM_AI_PORT_BINDINGS).filter((file) => !importing.has(file))).toEqual([]);
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

  describe('the @marinoscar/kvox-ai package (#579)', () => {
    const packageEdges = walk(KVOX_AI_PACKAGE_SRC).flatMap((full) =>
      findSpecifiers(full, readFileSync(full, 'utf8')).map((found) => ({
        file: `packages/kvox-ai/src/${posix(relative(KVOX_AI_PACKAGE_SRC, full))}`,
        ...found,
      })),
    );

    it('is scanned at all, and does import the platform AI package (so the rule below is not vacuous)', () => {
      expect(packageEdges.length).toBeGreaterThan(0);
      expect(packageEdges.some(({ specifier }) => specifier === PLATFORM_AI)).toBe(true);
    });

    it('imports the platform only through exactly @marinoscar/platform-api/ai', () => {
      const violations = packageEdges
        .filter(({ specifier }) => specifier.startsWith('@marinoscar/platform-') && specifier !== PLATFORM_AI)
        .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

      expect(violations).toEqual([]);
    });

    it('imports no Nest, no Prisma and no @app/shared', () => {
      const violations = packageEdges
        .filter(({ specifier }) => KVOX_AI_PACKAGE_FORBIDDEN.some((pattern) => pattern.test(specifier)))
        .map(({ file, line, specifier }) => `${file}:${line} imports "${specifier}"`);

      expect(violations).toEqual([]);
    });
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
