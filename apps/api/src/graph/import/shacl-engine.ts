// =============================================================================
// SHACL validation for `kg.import`, in a child Node process (#387,
// docs/specs/ontology.md §18.3, §18.4)
// =============================================================================
//
// `rdf-validate-shacl` is ESM-only; this API is compiled to CommonJS. Rather
// than depend on how a dynamic `import()` behaves under each runtime that
// loads this file (the compiled Nest build, and Jest's `vm` context — where it
// needs `--experimental-vm-modules` and still depends on which worker loaded
// it first), validation runs in a CHILD `node` process started with an inline
// ES-module script. That is deterministic everywhere, and it earns two more
// things an untrusted upload needs:
//
//   - THE WORKER'S EVENT LOOP STAYS FREE. The engine's `validateAll` is
//     synchronous; over 200,000 triples it can run for a long time, and on the
//     worker's own thread it would starve lease renewal for every job in the
//     process. In a child it blocks only the child.
//   - A HARD MEMORY CEILING and a TIMEOUT, both enforced from outside: a
//     pathological file costs one killed child, never the API's heap.
//
// Protocol: stdin is JSON `{ moduleUrl, shapes, data, maxResults }`, each quad
// `[s, p, o]` with terms `{ t: 'N'|'B'|'L', v, d?, l? }`; stdout is JSON
// `{ conforms, violationCount, warningCount, results }` — `results` capped at
// `maxResults`, violations first. `conforms` means "no `sh:Violation`":
// warnings are reported and never fail an import.
//
// ⚠ §18.4: only the `kg.import` job handler imports this file.
// =============================================================================

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import type { ImportQuad, ImportTerm } from './import-dataset';

export interface ShaclResultRecord {
  /** The failing node's IRI, or `_:label`. */
  focusNode: string;
  path: string | null;
  message: string;
  severity: 'Violation' | 'Warning' | 'Info';
}

export interface ShaclEngineReport {
  /** No `sh:Violation` (warnings allowed). */
  conforms: boolean;
  violationCount: number;
  warningCount: number;
  /** At most `maxResults`, violations first. */
  results: ShaclResultRecord[];
}

export interface ShaclEngine {
  validate(shapes: readonly ImportQuad[], data: readonly ImportQuad[], maxResults: number): Promise<ShaclEngineReport>;
}

/** Ceilings for one validation run. */
export interface ChildProcessShaclOptions {
  timeoutMs: number;
  maxOldSpaceMb: number;
}

export const DEFAULT_SHACL_OPTIONS: ChildProcessShaclOptions = { timeoutMs: 20 * 60_000, maxOldSpaceMb: 2048 };

/** The inline ES module the child runs. Plain JavaScript; reads everything it needs from stdin. */
export const SHACL_CHILD_SCRIPT = `
const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
const { default: SHACLValidator } = await import(input.moduleUrl);
const f = new SHACLValidator([]).factory;
const term = (t) => t.t === 'N' ? f.namedNode(t.v) : t.t === 'B' ? f.blankNode(t.v) : f.literal(t.v, t.l ? t.l : f.namedNode(t.d));
const quads = (rows) => rows.map(([s, p, o]) => f.quad(term(s), f.namedNode(p), term(o)));
const validator = new SHACLValidator(quads(input.shapes), { factory: f });
const report = await validator.validate(f.dataset(quads(input.data)));
const name = (t) => (t ? (t.termType === 'BlankNode' ? '_:' + t.value : t.value) : null);
const local = (t) => (t ? String(t.value).split(/[#/]/).pop() : null);
const COMPONENT_MESSAGES = {
  ClassConstraintComponent: 'The value is not a node of an allowed type',
  ClosedConstraintComponent: 'The property is not allowed on this node',
  NodeKindConstraintComponent: 'The value is not the right kind of node',
  OrConstraintComponent: 'The value satisfies none of the allowed alternatives',
  DatatypeConstraintComponent: 'The value does not have the required datatype',
};
const all = report.results.map((r) => ({
  focusNode: name(r.focusNode) ?? '',
  path: name(r.path),
  message: (r.message ?? []).map((m) => m.value).join(' ') || COMPONENT_MESSAGES[local(r.sourceConstraintComponent)] || local(r.sourceConstraintComponent) || 'Constraint not satisfied',
  severity: local(r.severity) ?? 'Violation',
}));
const violations = all.filter((r) => r.severity === 'Violation');
const others = all.filter((r) => r.severity !== 'Violation');
process.stdout.write(JSON.stringify({
  conforms: violations.length === 0,
  violationCount: violations.length,
  warningCount: others.filter((r) => r.severity === 'Warning').length,
  results: [...violations, ...others].slice(0, input.maxResults),
}));
`;

type WireTerm = { t: 'N' | 'B' | 'L'; v: string; d?: string; l?: string };

function wireTerm(term: ImportTerm): WireTerm {
  if (term.termType === 'NamedNode') return { t: 'N', v: term.value };
  if (term.termType === 'BlankNode') return { t: 'B', v: term.value };
  return term.language
    ? { t: 'L', v: term.value, l: term.language }
    : { t: 'L', v: term.value, d: term.datatype ?? 'http://www.w3.org/2001/XMLSchema#string' };
}

function wire(quads: readonly ImportQuad[]): Array<[WireTerm, string, WireTerm]> {
  return quads.map((q) => [wireTerm(q.s), q.p, wireTerm(q.o)]);
}

/** Where the engine lives, as a `file:` URL the child can `import()`. */
export function shaclModuleUrl(): string {
  return pathToFileURL(require.resolve('rdf-validate-shacl')).href;
}

export class ChildProcessShaclEngine implements ShaclEngine {
  constructor(private readonly options: ChildProcessShaclOptions = DEFAULT_SHACL_OPTIONS) {}

  validate(shapes: readonly ImportQuad[], data: readonly ImportQuad[], maxResults: number): Promise<ShaclEngineReport> {
    const input = JSON.stringify({ moduleUrl: shaclModuleUrl(), shapes: wire(shapes), data: wire(data), maxResults });
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${this.options.maxOldSpaceMb}`, '--input-type=module', '-e', SHACL_CHILD_SCRIPT],
        // A clean Node: no inherited NODE_OPTIONS (a test runner's or a profiler's flags are not the child's).
        { env: { ...process.env, NODE_OPTIONS: '' }, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill('SIGKILL');
        reject(new Error(`SHACL validation did not finish within ${this.options.timeoutMs} ms`));
      }, this.options.timeoutMs);
      timer.unref?.();

      child.stdout.on('data', (c: Buffer) => out.push(c));
      child.stderr.on('data', (c: Buffer) => err.push(c));
      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      });
      child.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code !== 0) {
          // stderr names engine internals, never the file's content.
          reject(new Error(`SHACL validation exited with code ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 500)}`));
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf8')) as ShaclEngineReport);
        } catch (parseError) {
          reject(new Error(`SHACL validation printed no report: ${String(parseError)}`));
        }
      });
      child.stdin.on('error', () => undefined); // a child that died early surfaces through 'close'
      child.stdin.end(input);
    });
  }
}
