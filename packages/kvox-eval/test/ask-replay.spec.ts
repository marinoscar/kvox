/**
 * The package twin of `apps/api/test/ask/ask-eval.replay.db.spec.ts` (#608): the
 * same six scripted questions, on the real PGlite host through `runAskReplay`
 * (real handler, toolset, handle registry, citation mapper and `createKvoxAi`
 * event mapping; a scripted runtime under them). One host for the whole file.
 */

import { scoreCitationValidity, scoreSensitiveLeak } from '../src/ask/index';
import { ASK_REPLAY_SCENARIOS, ASK_REPLAY_SENSITIVE_TEXT, runAskReplay, type AskReplayResult, type AskReplayRun } from '../src/ask-run/replay';

jest.setTimeout(240_000);

let run: AskReplayRun;
const by = (id: string): AskReplayResult => {
  const r = run.results.find((x) => x.scenario.id === id);
  if (!r) throw new Error(`no result ${id}`);
  return r;
};

beforeAll(async () => {
  run = await runAskReplay();
}, 240_000);

describe('ask replay (PGlite, scripted runtime, no model)', () => {
  it('runs the six scenarios, each complete', () => {
    expect(ASK_REPLAY_SCENARIOS.map((s) => s.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    expect(run.results.map((r) => r.scenario.id)).toEqual(['r1', 'r2', 'r3', 'r4', 'r5', 'r6']);
    for (const r of run.results) expect({ id: r.scenario.id, status: r.message.status }).toEqual({ id: r.scenario.id, status: 'complete' });
  });

  it('five questions have citation validity 1.0 and the planted one is below 1, with ev99 invalid and unresolved', () => {
    for (const id of ['r1', 'r2', 'r3', 'r4', 'r5']) {
      expect(scoreCitationValidity(by(id).message.citations)).toBe(1);
      expect(by(id).message.citations.every((c) => c.valid)).toBe(true);
    }
    const planted = by('r6').message;
    expect(scoreCitationValidity(planted.citations)).toBeLessThan(1);
    expect(planted.citations.find((c) => c.marker === 'ev99')).toMatchObject({ valid: false, id: null });
  });

  it('the marker and kind assertions of the app spec hold', () => {
    const r2 = by('r2').message.citations;
    expect(r2).toHaveLength(1);
    expect(r2[0]).toMatchObject({ marker: 'ev1', kind: 'evidence', valid: true });
    expect(by('r4').message.citations).toHaveLength(0);
    expect(scoreCitationValidity(by('r4').message.citations)).toBe(1);
  });

  it('every scenario met its own expectation and every scripted model call played', () => {
    for (const r of run.results) expect({ id: r.scenario.id, failures: r.failures }).toEqual({ id: r.scenario.id, failures: [] });
    expect(run.passed).toBe(true);
  });

  it('pins the baseline: ordered tool calls and citation markers with valid flags', () => {
    const baseline = run.results.map((r) => ({
      id: r.scenario.id,
      tools: r.message.toolCalls.map((c) => c.name),
      citations: r.message.citations.map((c) => `${c.marker}:${c.valid}`),
    }));
    expect(baseline).toEqual([
      { id: 'r1', tools: ['search', 'get_entity'], citations: ['ent1:true'] },
      { id: 'r2', tools: ['search', 'evidence'], citations: ['ev1:true'] },
      { id: 'r3', tools: ['search', 'timeline', 'evidence'], citations: ['ev1:true'] },
      { id: 'r4', tools: ['search'], citations: [] },
      { id: 'r5', tools: ['search', 'get_entity', 'evidence'], citations: ['ent1:true', 'ev1:true'] },
      { id: 'r6', tools: ['search', 'get_entity'], citations: ['ent1:true', 'ev99:false'] },
    ]);
  });

  it('the leak gate: the sensitive fact reaches no captured request and no answer', () => {
    expect(run.results.flatMap((r) => r.capturedPrompts).length).toBeGreaterThan(0);
    for (const r of run.results) {
      for (const p of r.capturedPrompts) expect(p.toLowerCase()).not.toContain(ASK_REPLAY_SENSITIVE_TEXT);
      expect(r.message.content.toLowerCase()).not.toContain(ASK_REPLAY_SENSITIVE_TEXT);
      expect(scoreSensitiveLeak([ASK_REPLAY_SENSITIVE_TEXT], r.message.content, [])).toBe(false);
    }
    expect(run.leakFree).toBe(true);
  });
});
