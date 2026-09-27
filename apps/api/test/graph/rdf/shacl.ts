import { execFile } from 'node:child_process';
import { join } from 'node:path';

import { Parser, Writer, type Quad } from 'n3';

// =============================================================================
// validateShacl — run rdf-validate-shacl for a spec, deterministically (#386)
// =============================================================================
//
// The engine is ESM-only; it runs in a child `node` process (`shacl-runner.mjs`)
// rather than through a dynamic `import()` inside Jest's vm context, which
// depended on how Jest was launched and on which worker loaded it first. See
// the runner's header. Inputs travel as N-Quads, so blank-node labels survive.
// =============================================================================

export interface ShaclTerm {
  value: string;
}

export interface ShaclResult {
  focusNode: ShaclTerm | null;
  path: ShaclTerm | null;
  sourceConstraintComponent: ShaclTerm | null;
  message: ShaclTerm[];
}

export interface ShaclReport {
  conforms: boolean;
  results: ShaclResult[];
}

const RUNNER = join(__dirname, 'shacl-runner.mjs');

function toNQuads(input: string | readonly Quad[]): string {
  const quads = typeof input === 'string' ? new Parser().parse(input) : input;
  return new Writer({ format: 'N-Quads' }).quadsToString([...quads]);
}

/** Validate `data` against `shapes` (Turtle text or parsed quads, either argument). */
export function validateShacl(shapes: string | readonly Quad[], data: string | readonly Quad[]): Promise<ShaclReport> {
  const input = JSON.stringify({ shapes: toNQuads(shapes), data: toNQuads(data) });
  return new Promise((resolve, reject) => {
    const child = execFile(
      process.execPath,
      [RUNNER],
      // A clean Node: no inherited NODE_OPTIONS (a Jest launcher's flags are not the runner's).
      { env: { ...process.env, NODE_OPTIONS: '' }, maxBuffer: 64 * 1024 * 1024, cwd: __dirname },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`shacl-runner failed: ${error.message}\n${stderr}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout) as ShaclReport);
        } catch (parseError) {
          reject(new Error(`shacl-runner printed no report: ${String(parseError)}\n${stdout}\n${stderr}`));
        }
      },
    );
    child.stdin?.end(input);
  });
}
