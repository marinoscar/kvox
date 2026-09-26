import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// =============================================================================
// No RDF library in the request path (#385, docs/specs/ontology.md §18.4)
// =============================================================================
//
// §18.4 confines `n3`, `jsonld` and `rdf-validate-shacl` to the export/import
// JOB handlers. In #385 nothing needs them at runtime at all — the ontology
// artefacts are written by the hand-written `graph/rdf/turtle-writer.ts` — so
// no non-test file under `apps/api/src/` may import one (or `rdf-ext`, which
// only the tests use). #386/#387 narrow this rule to "only their handlers"
// when they move what they need to `dependencies`.
//
// A text scan rather than a module graph walk: an import is a string in a file,
// and a grep is the check a reviewer would run by hand.
// =============================================================================

const SRC = join(__dirname, '..', '..', '..', 'src');
const FORBIDDEN = ['n3', 'jsonld', 'rdf-validate-shacl', 'rdf-ext'];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [path] : [];
  });
}

/** `from 'x'`, `import 'x'`, `require('x')`, `import('x')` — and any subpath `x/…`. */
function importsOf(pkg: string): RegExp {
  const name = pkg.replace(/[-/]/g, (c) => `\\${c}`);
  return new RegExp(`(?:\\bfrom\\s+|\\bimport\\s+|\\brequire\\s*\\(\\s*|\\bimport\\s*\\(\\s*)['"\`]${name}(?:/[^'"\`]*)?['"\`]`);
}

describe('RDF libraries stay out of apps/api/src (§18.4)', () => {
  const files = sourceFiles(SRC);

  it('scans a non-trivial number of files', () => {
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(join('graph', 'rdf', 'turtle-writer.ts')))).toBe(true);
  });

  it.each(FORBIDDEN)('no non-test file imports %s', (pkg) => {
    const pattern = importsOf(pkg);
    const offenders = files.filter((f) => pattern.test(readFileSync(f, 'utf8'))).map((f) => relative(SRC, f));
    expect(offenders).toEqual([]);
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
    ]) {
      expect(pattern.test(line)).toBe(true);
    }
    expect(pattern.test("import { x } from 'n3-something';")).toBe(false);
  });
});
