// =============================================================================
// SHACL validation for `kg.import`, in a child Node process (#387,
// docs/specs/ontology.md §18.3, §18.4)
// =============================================================================
//
// `rdf-validate-shacl` is ESM-only; this API is compiled to CommonJS. Rather
// than depend on how a dynamic `import()` behaves under each runtime that
// loads this file (the compiled Nest build, and Jest's `vm` context — where it
// needs `--experimental-vm-modules` and still depends on which worker loaded
// it first), validation runs in a CHILD `node` process running the plain
// CommonJS script `runners/shacl-runner.cjs`, the one implementation of the
// step. That is deterministic everywhere, and it earns two more things an
// untrusted upload needs:
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
// A HOST THAT CANNOT SPAWN NODE (KVox Desktop: `process.execPath` is the
// Electron binary and its RunAsNode fuse is off) passes `shacl.run` to
// `GraphRdfModule.forRoot`: the engine hands it the same input JSON instead of
// spawning, and the host runs `runShaclValidation`
// (`@marinoscar/kvox-api/graph-rdf/shacl-runner`, the same script) in an
// isolated process of its own. The timeout still applies; the host owns the
// process and its memory ceiling, and is told to stop through `signal`.
//
// ⚠ §18.4: only the `kg.import` job handler imports this file.
// =============================================================================

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { shaclRunnerScriptPath, type ShaclRun } from '../shacl-runner/index.js';
import type { ImportQuad, ImportTerm } from './import-dataset.js';

/**
 * The shacl result record type.
 *
 * @stability experimental
 */
export interface ShaclResultRecord {
  /** The failing node's IRI, or `_:label`. */
  focusNode: string;
  /**
   * The path.
   */
  path: string | null;
  /**
   * The message.
   */
  message: string;
  /**
   * The severity.
   */
  severity: 'Violation' | 'Warning' | 'Info';
}

/**
 * The shacl engine report type.
 *
 * @stability experimental
 */
export interface ShaclEngineReport {
  /** No `sh:Violation` (warnings allowed). */
  conforms: boolean;
  /**
   * The violation count.
   */
  violationCount: number;
  /**
   * The warning count.
   */
  warningCount: number;
  /** At most `maxResults`, violations first. */
  results: ShaclResultRecord[];
}

/**
 * The shacl engine type.
 *
 * @stability experimental
 */
export interface ShaclEngine {
  /**
   * Validate.
   */
  validate(shapes: readonly ImportQuad[], data: readonly ImportQuad[], maxResults: number): Promise<ShaclEngineReport>;
}

/** Ceilings for one validation run, and the host's runner when it does not spawn Node. */
export interface ChildProcessShaclOptions {
  timeoutMs: number;
  /** The child's heap ceiling. Not applied to `run`: the host sizes its own process. */
  maxOldSpaceMb: number;
  /** Validate through the host instead of spawning `process.execPath`. */
  run?: ShaclRun;
}

export const DEFAULT_SHACL_OPTIONS: ChildProcessShaclOptions = { timeoutMs: 20 * 60_000, maxOldSpaceMb: 2048 };

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

/**
 * Boot check: the optional peer `rdf-validate-shacl` must be installed next to this package.
 *
 * @throws Error naming the missing peer when it cannot be resolved.
 * @stability experimental
 */
export function assertShaclEngineResolvable(): void {
  try {
    require.resolve('rdf-validate-shacl');
  } catch (error) {
    throw new Error(
      'The graph import needs the optional peer dependency "rdf-validate-shacl" (SHACL validation of ' +
        'an uploaded file), and it cannot be resolved from @marinoscar/kvox-api. Install it in the host ' +
        'application, or mount GraphRdfModule.forRoot({ import: false }). ' +
        `(${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

/** The engine's output JSON, parsed as the report; the same message whoever printed it. */
function parseReport(output: string): ShaclEngineReport {
  try {
    return JSON.parse(output) as ShaclEngineReport;
  } catch (parseError) {
    throw new Error(`SHACL validation printed no report: ${String(parseError)}`);
  }
}

function timeoutError(timeoutMs: number): Error {
  return new Error(`SHACL validation did not finish within ${timeoutMs} ms`);
}

export class ChildProcessShaclEngine implements ShaclEngine {
  constructor(private readonly options: ChildProcessShaclOptions = DEFAULT_SHACL_OPTIONS) {}

  validate(shapes: readonly ImportQuad[], data: readonly ImportQuad[], maxResults: number): Promise<ShaclEngineReport> {
    const input = JSON.stringify({ moduleUrl: shaclModuleUrl(), shapes: wire(shapes), data: wire(data), maxResults });
    return this.options.run ? this.validateWithHost(this.options.run, input) : this.validateInChild(input);
  }

  private validateWithHost(run: ShaclRun, input: string): Promise<ShaclEngineReport> {
    return new Promise((resolve, reject) => {
      const abort = new AbortController();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        abort.abort();
        reject(timeoutError(this.options.timeoutMs));
      }, this.options.timeoutMs);
      timer.unref?.();

      const settle = (outcome: () => ShaclEngineReport): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          resolve(outcome());
        } catch (error) {
          reject(error as Error);
        }
      };
      // A synchronous throw from `run` is a failed run, like a rejection.
      Promise.resolve()
        .then(() => run(input, { signal: abort.signal }))
        .then(
          (output) => settle(() => parseReport(String(output))),
          (error: unknown) =>
            settle(() => {
              // The runner's reason names engine internals, never the file's content.
              throw new Error(`SHACL validation failed: ${(error instanceof Error ? error.message : String(error)).slice(0, 500)}`);
            }),
        );
    });
  }

  private validateInChild(input: string): Promise<ShaclEngineReport> {
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [`--max-old-space-size=${this.options.maxOldSpaceMb}`, shaclRunnerScriptPath()],
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
        reject(timeoutError(this.options.timeoutMs));
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
          resolve(parseReport(Buffer.concat(out).toString('utf8')));
        } catch (error) {
          reject(error as Error);
        }
      });
      child.stdin.on('error', () => undefined); // a child that died early surfaces through 'close'
      child.stdin.end(input);
    });
  }
}
