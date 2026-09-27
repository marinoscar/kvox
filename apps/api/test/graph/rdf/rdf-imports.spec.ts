import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// =============================================================================
// No RDF library in the request path (#385, #386; docs/specs/ontology.md §18.4)
// =============================================================================
//
// §18.4 confines `n3`, `jsonld` and `rdf-validate-shacl` to the export/import
// JOB handlers. The ontology artefacts (#385) are written by the hand-written
// `graph/rdf/turtle-writer.ts`. The data export (#386) keeps `n3`/`jsonld`
// inside ONE file — `graph/export/serializers.ts` — which only the `kg.export`
// handler reaches. The import (#387) widens the allowlist by exactly the two
// files its handler needs: `graph/import/rdf-parse.ts` (`n3`, `jsonld`) and
// `graph/import/shacl-engine.ts` (`rdf-validate-shacl`, resolved by path and
// run in a child process). `rdf-ext` stays test-only; and each of those three
// files is imported by job handlers only, never a controller or service.
//
// A text scan rather than a module graph walk: an import is a string in a file,
// and a grep is the check a reviewer would run by hand.
// =============================================================================

const SRC = join(__dirname, '..', '..', '..', 'src');
const FORBIDDEN = ['n3', 'jsonld', 'rdf-validate-shacl', 'rdf-ext'];

/** The only files allowed to import a given library: the export serializer (#386), the import parser and SHACL runner (#387). */
const ALLOWED: Readonly<Record<string, readonly string[]>> = {
  n3: [join('graph', 'export', 'serializers.ts'), join('graph', 'import', 'rdf-parse.ts')],
  jsonld: [join('graph', 'export', 'serializers.ts'), join('graph', 'import', 'rdf-parse.ts')],
  'rdf-validate-shacl': [join('graph', 'import', 'shacl-engine.ts')],
};

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** `from 'x'`, `import 'x'`, `require('x')`, `require.resolve('x')`, `import('x')` — and any subpath `x/…`. */
function importsOf(pkg: string): RegExp {
  const name = pkg.replace(/[-/]/g, (c) => `\\${c}`);
  return new RegExp(
    `(?:\\bfrom\\s+|\\bimport\\s+|\\brequire(?:\\.resolve)?\\s*\\(\\s*|\\bimport\\s*\\(\\s*)['"\`]${name}(?:/[^'"\`]*)?['"\`]`,
  );
}

describe('RDF libraries stay out of apps/api/src (§18.4)', () => {
  const files = sourceFiles(SRC);

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('graph', 'rdf', 'turtle-writer.ts')))).toBe(true);
  });

  it.each(FORBIDDEN)('no non-test file outside its allowlist imports %s', (pkg) => {
    const pattern = importsOf(pkg);
    const offenders = files
      .filter((f) => pattern.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f))
      .filter((f) => !(ALLOWED[pkg] ?? []).includes(f));
    expect(offenders).toEqual([]);
  });

  it('the export serializer is imported only by job handlers, never a controller or service', () => {
    const importers = files
      .filter((f) => /from\s+['"][./]*(?:export\/)?serializers['"]/.test(readFileSync(f, 'utf8')))
      .map((f) => relative(SRC, f));
    for (const importer of importers) expect(importer).toMatch(/\.handler\.ts$/);
  });

  it.each(['rdf-parse', 'shacl-engine'])('the import job’s %s is imported only by job handlers', (module) => {
    const pattern = new RegExp(`from\\s+['"][./]*(?:import\\/)?${module}['"]`);
    const importers = files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(importers.length).toBeGreaterThan(0);
    for (const importer of importers) expect(importer).toMatch(/\.handler\.ts$/);
  });

  it('recognises every import form it is meant to catch', () => {
    const pattern = importsOf('n3');
    for (const line of [
      "import { Parser } from 'n3';",
      'import * as N3 from "n3";',
      "import 'n3';",
      "const n3 = require('n3');",
      "await import('n3')",
      "import { Writer } from 'n3/lib/N3Writer';",
      "require.resolve('n3')",
    ]) {
      expect(pattern.test(line)).toBe(true);
    }
    expect(pattern.test("import { x } from 'n3-something';")).toBe(false);
  });
});
