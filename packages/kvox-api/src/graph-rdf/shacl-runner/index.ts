// The SHACL runner entry of @marinoscar/kvox-api (`@marinoscar/kvox-api/graph-rdf/shacl-runner`, issue #586).
//
// A LIGHT entry: Node built-ins only, no Nest, no Prisma, nothing else of the graph-rdf slice, so
// a host can load it in a bare isolated process (a worker, an Electron utility process) and run
// the import's SHACL validation there. It wraps `runners/shacl-runner.cjs`, the one
// implementation the default child process runs too.

import { resolve } from 'node:path';

/**
 * Runs one SHACL validation in an isolated process of the host's choosing: receives the JSON the
 * default child reads on stdin, resolves with the JSON report it prints (what `runShaclValidation`
 * of `@marinoscar/kvox-api/graph-rdf/shacl-runner` returns). `signal` aborts when the engine stops
 * waiting (its timeout): the host then kills its process.
 *
 * @stability experimental
 */
export type ShaclRun = (input: string, options: { signal: AbortSignal }) => Promise<string>;

/**
 * The runner script: `runners/shacl-runner.cjs` of this package. Three levels up from both
 * `src/graph-rdf/shacl-runner` and from `dist/graph-rdf/shacl-runner`.
 *
 * @returns the absolute path of the script.
 * @stability experimental
 */
export function shaclRunnerScriptPath(): string {
  return resolve(__dirname, '..', '..', '..', 'runners', 'shacl-runner.cjs');
}

/**
 * Runs one SHACL validation of a graph import, in the calling process.
 *
 * It is what `GraphRdfModule.forRoot({ shacl: { run } })` asks a host to do in an isolated
 * process: `input` is the JSON the engine hands to `run` (it names the engine with a `file:` URL
 * the import job resolved, `moduleUrl`, plus the shapes, the data and the result cap), the
 * promise resolves with the JSON report the engine parses. The validation is synchronous CPU
 * work over up to the import's triple ceiling: call it in a process of its own, never on a
 * server's event loop.
 *
 * @example
 * ```js
 * // The script a host runs in its isolated process (CommonJS).
 * const { runShaclValidation } = require('@marinoscar/kvox-api/graph-rdf/shacl-runner');
 * const input = require('node:fs').readFileSync(process.argv[2], 'utf8');
 * runShaclValidation(input).then((report) => process.stdout.write(report));
 * ```
 *
 * @param input - the engine's input JSON.
 * @returns the report JSON.
 * @throws when the input is not the engine's JSON, the engine cannot be loaded from `moduleUrl`,
 * or the validation fails.
 * @stability experimental
 */
export function runShaclValidation(input: string): Promise<string> {
  const runner = require(shaclRunnerScriptPath()) as { runShaclValidation(input: string): Promise<string> };
  return runner.runShaclValidation(input);
}
