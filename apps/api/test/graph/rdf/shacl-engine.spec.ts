import { ChildProcessShaclEngine, shaclModuleUrl } from '../../../src/graph/import/shacl-engine';
import { parseTurtleText } from '../../../src/graph/import/rdf-parse';

// =============================================================================
// The production SHACL runner (#387): a real child process, under Jest
// =============================================================================
//
// `kg.import` validates in a child `node` started with an inline ES module —
// the reason being that the ESM-only engine loads there the same way under
// Jest and under the compiled Nest build. This runs the real thing: a
// violation is reported with its node, path and message; a warning does not
// fail `conforms`; results are capped with violations first; a runaway run is
// killed at its timeout.
// =============================================================================

const SHAPES = parseTurtleText(`
@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/> .
ex:PShape a sh:NodeShape ; sh:targetClass ex:P ;
  sh:property [ sh:path ex:name ; sh:minCount 1 ] ;
  sh:property [ sh:path ex:nick ; sh:maxCount 1 ; sh:severity sh:Warning ] .`);

describe('ChildProcessShaclEngine', () => {
  const engine = new ChildProcessShaclEngine({ timeoutMs: 60_000, maxOldSpaceMb: 256 });

  it('resolves the engine as a file URL', () => {
    expect(shaclModuleUrl()).toMatch(/^file:\/\/.*rdf-validate-shacl/);
  });

  it('conforms for valid data', async () => {
    const data = parseTurtleText('@prefix ex: <https://ex.example/> . ex:a a ex:P ; ex:name "A" .');
    await expect(engine.validate(SHAPES, data, 10)).resolves.toEqual({ conforms: true, violationCount: 0, warningCount: 0, results: [] });
  });

  it('reports violations first, warnings without failing, and caps the list', async () => {
    const data = parseTurtleText(`@prefix ex: <https://ex.example/> .
      ex:a a ex:P ; ex:name "A" ; ex:nick "x", "y" .
      ex:b a ex:P . ex:c a ex:P . _:d a ex:P .`);
    const report = await engine.validate(SHAPES, data, 2);
    expect(report.conforms).toBe(false);
    expect(report.violationCount).toBe(3);
    expect(report.warningCount).toBe(1);
    expect(report.results).toHaveLength(2);
    expect(report.results.every((r) => r.severity === 'Violation' && r.path === 'https://ex.example/name')).toBe(true);
    expect(report.results[0].message).toBe('Less than 1 values');

    const warningsOnly = await engine.validate(SHAPES, parseTurtleText('@prefix ex: <https://ex.example/> . ex:a a ex:P ; ex:name "A" ; ex:nick "x", "y" .'), 10);
    expect(warningsOnly).toMatchObject({ conforms: true, violationCount: 0, warningCount: 1 });
    expect(warningsOnly.results[0]).toMatchObject({ severity: 'Warning', focusNode: 'https://ex.example/a' });
  }, 60_000);

  it('names a blank focus node as _:label', async () => {
    const report = await engine.validate(SHAPES, parseTurtleText('@prefix ex: <https://ex.example/> . _:x a ex:P .'), 10);
    expect(report.results[0].focusNode).toMatch(/^_:/);
  });

  it('kills a run that outlives its timeout', async () => {
    const slow = new ChildProcessShaclEngine({ timeoutMs: 1, maxOldSpaceMb: 256 });
    await expect(slow.validate(SHAPES, [], 10)).rejects.toThrow(/did not finish within 1 ms/);
  });
});
