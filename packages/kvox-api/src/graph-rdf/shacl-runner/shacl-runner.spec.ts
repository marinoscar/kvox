import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';

import { parseTurtleText } from '../import/rdf-parse.js';
import { ChildProcessShaclEngine, shaclModuleUrl } from '../import/shacl-engine.js';
import { runShaclValidation, shaclRunnerScriptPath } from './index.js';

// =============================================================================
// `@marinoscar/kvox-api/graph-rdf/shacl-runner` (#586)
// =============================================================================
//
// The function a host's isolated process calls (KVox Desktop's utility process, whose Electron
// binary cannot be spawned as Node). It really validates with `rdf-validate-shacl`, returns what
// the default child prints for the same input, and loads with Node built-ins only: no Nest, no
// Prisma, nothing else of the slice.
// =============================================================================

const SHAPES = parseTurtleText(`
@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/> .
ex:PShape a sh:NodeShape ; sh:targetClass ex:P ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] ;
  sh:property [ sh:path ex:nick ; sh:maxCount 1 ; sh:severity sh:Warning ] .`);

/** The engine's wire input for `data`, captured from the engine itself so the test cannot drift from it. */
async function engineInput(turtle: string, maxResults: number): Promise<string> {
  let captured = '';
  const engine = new ChildProcessShaclEngine({
    timeoutMs: 10_000,
    maxOldSpaceMb: 256,
    run: async (input) => {
      captured = input;
      return '{"conforms":true,"violationCount":0,"warningCount":0,"results":[]}';
    },
  });
  await engine.validate(SHAPES, parseTurtleText(turtle), maxResults);
  return captured;
}

/** The code without its comments (the TSDoc example names the package's own entry). */
const stripComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('runShaclValidation', () => {
  it('conforms for valid data', async () => {
    const input = await engineInput('@prefix ex: <https://ex.example/> . ex:a a ex:P ; ex:name "A" .', 10);
    expect(JSON.parse(await runShaclValidation(input))).toEqual({ conforms: true, violationCount: 0, warningCount: 0, results: [] });
  }, 60_000);

  it('reports violations first, warnings without failing, capped, and names a blank node _:label', async () => {
    const input = await engineInput(
      `@prefix ex: <https://ex.example/> .
       ex:a a ex:P ; ex:name "A" ; ex:nick "x", "y" .
       ex:b a ex:P . _:c a ex:P .`,
      2,
    );
    const report = JSON.parse(await runShaclValidation(input));
    expect(report).toMatchObject({ conforms: false, violationCount: 2, warningCount: 1 });
    expect(report.results).toHaveLength(2);
    expect(report.results.every((r: { severity: string }) => r.severity === 'Violation')).toBe(true);
    expect(report.results[0]).toMatchObject({ path: 'https://ex.example/name', message: 'Less than 1 values' });
    expect(report.results.some((r: { focusNode: string }) => r.focusNode.startsWith('_:'))).toBe(true);
  }, 60_000);

  it('returns exactly what the default child prints for the same input', async () => {
    const turtle = '@prefix ex: <https://ex.example/> . ex:a a ex:P ; ex:nick "x", "y" .';
    const inProcess = JSON.parse(await runShaclValidation(await engineInput(turtle, 10)));
    const child = await new ChildProcessShaclEngine({ timeoutMs: 60_000, maxOldSpaceMb: 256 }).validate(SHAPES, parseTurtleText(turtle), 10);
    expect(inProcess).toEqual(child);
  }, 60_000);

  it('rejects an input that is not the engine’s JSON, or an engine it cannot load', async () => {
    await expect(runShaclValidation('not json')).rejects.toThrow();
    const input = JSON.stringify({ moduleUrl: 'file:///nowhere/rdf-validate-shacl/index.js', shapes: [], data: [], maxResults: 1 });
    await expect(runShaclValidation(input)).rejects.toThrow();
  });

  it('is a light entry: the script and its wrapper load Node built-ins only', () => {
    expect(existsSync(shaclRunnerScriptPath())).toBe(true);
    expect(shaclModuleUrl()).toMatch(/^file:/);
    const builtins = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);
    const specifiers = (path: string): string[] =>
      [...stripComments(readFileSync(path, 'utf8')).matchAll(/(?:\bfrom\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const path of [shaclRunnerScriptPath(), require.resolve('./index.ts')]) {
      expect(specifiers(path).filter((s) => !builtins.has(s))).toEqual([]);
    }
  });
});
