import { parseTurtleText } from './rdf-parse.js';
import { ChildProcessShaclEngine, DEFAULT_SHACL_OPTIONS, type ShaclEngineReport } from './shacl-engine.js';
import type { ShaclRun } from '../shacl-runner/index.js';
import { resolveGraphRdfOptions } from '../graph-rdf.options.js';

// =============================================================================
// The SHACL engine's two ways to run (#387, #586)
// =============================================================================
//
// By default a child `node` runs `runners/shacl-runner.cjs`. A host whose binary cannot run Node
// passes `shacl.run`: the engine hands it the very input the child reads on stdin, parses what it
// returns as the report, and maps a failure, garbage or a slow run to the child's errors. The
// child's own behaviour in depth: `apps/api/test/graph/rdf/shacl-engine.spec.ts`.
// =============================================================================

const SHAPES = parseTurtleText(`
@prefix sh: <http://www.w3.org/ns/shacl#> . @prefix ex: <https://ex.example/> .
ex:PShape a sh:NodeShape ; sh:targetClass ex:P ; sh:property [ sh:path ex:name ; sh:minCount 1 ] .`);
const DATA = parseTurtleText('@prefix ex: <https://ex.example/> . ex:a a ex:P ; ex:label "A"@en .');

const REPORT: ShaclEngineReport = {
  conforms: false,
  violationCount: 1,
  warningCount: 0,
  results: [{ focusNode: 'https://ex.example/a', path: 'https://ex.example/name', message: 'Less than 1 values', severity: 'Violation' }],
};

function engineWith(run: ShaclRun, timeoutMs = 10_000): ChildProcessShaclEngine {
  return new ChildProcessShaclEngine({ ...DEFAULT_SHACL_OPTIONS, timeoutMs, run });
}

describe('ChildProcessShaclEngine', () => {
  it('spawns the runner script by default and reports a violation', async () => {
    const engine = new ChildProcessShaclEngine({ timeoutMs: 60_000, maxOldSpaceMb: 256 });
    await expect(engine.validate(SHAPES, DATA, 10)).resolves.toEqual(REPORT);
  }, 60_000);

  describe('with a host runner (shacl.run)', () => {
    it('hands it the child’s stdin JSON and returns its output as the report', async () => {
      const run = jest.fn<ReturnType<ShaclRun>, Parameters<ShaclRun>>(async () => JSON.stringify(REPORT));
      await expect(engineWith(run).validate(SHAPES, DATA, 7)).resolves.toEqual(REPORT);

      expect(run).toHaveBeenCalledTimes(1);
      const [input, { signal }] = run.mock.calls[0];
      const parsed = JSON.parse(input) as { moduleUrl: string; shapes: unknown[]; data: unknown[]; maxResults: number };
      expect(parsed.moduleUrl).toMatch(/^file:\/\/.*rdf-validate-shacl/);
      expect(parsed.maxResults).toBe(7);
      expect(parsed.shapes).toHaveLength(SHAPES.length);
      expect(parsed.data).toEqual([
        [{ t: 'N', v: 'https://ex.example/a' }, 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', { t: 'N', v: 'https://ex.example/P' }],
        [{ t: 'N', v: 'https://ex.example/a' }, 'https://ex.example/label', { t: 'L', v: 'A', l: 'en' }],
      ]);
      expect(signal.aborted).toBe(false);
    });

    it('fails like the child when the runner rejects or throws', async () => {
      await expect(engineWith(async () => Promise.reject(new Error('utility process exited with code 1'))).validate(SHAPES, DATA, 10)).rejects.toThrow(
        'SHACL validation failed: utility process exited with code 1',
      );
      await expect(
        engineWith(() => {
          throw new Error('cannot fork');
        }).validate(SHAPES, DATA, 10),
      ).rejects.toThrow('SHACL validation failed: cannot fork');
    });

    it('fails like the child when the runner prints no report', async () => {
      await expect(engineWith(async () => 'Segmentation fault').validate(SHAPES, DATA, 10)).rejects.toThrow(/SHACL validation printed no report/);
    });

    it('stops waiting at the timeout, as for the child, and aborts the signal', async () => {
      let seen: AbortSignal | undefined;
      const run: ShaclRun = (_input, { signal }) => {
        seen = signal;
        return new Promise(() => undefined);
      };
      await expect(engineWith(run, 5).validate(SHAPES, DATA, 10)).rejects.toThrow('SHACL validation did not finish within 5 ms');
      expect(seen?.aborted).toBe(true);
    });

    it('ignores a late answer after the timeout', async () => {
      let answer: (value: string) => void = () => undefined;
      const run: ShaclRun = () => new Promise((resolve) => (answer = resolve));
      const pending = engineWith(run, 5).validate(SHAPES, DATA, 10);
      await expect(pending).rejects.toThrow(/did not finish within 5 ms/);
      answer(JSON.stringify(REPORT));
      await expect(pending).rejects.toThrow(/did not finish/);
    });
  });
});

describe('resolveGraphRdfOptions shacl', () => {
  it('passes the host runner through, and spawns by default', () => {
    const run: ShaclRun = async () => '{}';
    expect(resolveGraphRdfOptions({ shacl: { run } }).shaclRun).toBe(run);
    expect(resolveGraphRdfOptions({}).shaclRun).toBeUndefined();
    expect(resolveGraphRdfOptions({ shacl: {} }).shaclRun).toBeUndefined();
  });
});
