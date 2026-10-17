/**
 * The `extract` kg:eval runner (#363): kg.extract's pure pipeline over one
 * golden fixture, with a scripted `KVOX_AI` (`createFakeKvoxAi` of
 * `@marinoscar/kvox-api/testing`) — no network, no key, no database.
 */

import { createFakeKvoxAi } from '@marinoscar/kvox-api/testing';

import { loadGoldenSet, selectFixtures } from '../../scripts/kg-eval/load';
import { kgEvalPredictionSchema } from '../../scripts/kg-eval/prediction-schema';
import { KG_EVAL_RUNNERS } from '../../scripts/kg-eval/runner';
import { createExtractRunner, fixtureToInput } from '../../scripts/kg-eval/runners/extract-runner';
import { scoreFixture } from '../../scripts/kg-eval/scorer';
import { buildExtractionContext } from './package-internals';

const [m01] = selectFixtures(loadGoldenSet(), ['m01'], null);

function stubAi(answer: unknown) {
  return createFakeKvoxAi({ script: { structured: answer } });
}

describe('kg:eval extract runner (#363)', () => {
  it('is registered as `extract`', async () => {
    expect(Object.keys(KG_EVAL_RUNNERS)).toContain('extract');
    const runner = await KG_EVAL_RUNNERS.extract();
    expect(runner.name).toBe('extract');
  });

  it('maps a fixture to an extraction input: speakers linked to known persons by name', () => {
    const ctx = buildExtractionContext(fixtureToInput(m01));
    expect(ctx.segments.map((s) => s.segmentId).slice(0, 2)).toEqual(['m01-s001', 'm01-s002']);
    expect(ctx.speakers.find((s) => s.name === 'Sarah Chen')?.personEntityId).toBe('g-person-sarah-chen');
    expect(ctx.speakers.find((s) => s.name === 'Tomás Aguilar')?.personEntityId).toBeNull();
    expect(ctx.meetingDate).toBe('2026-01-08');
  });

  it('runs one structured call and emits the Meeting, ATTENDED rows and cited evidence as a valid prediction', async () => {
    const tomasLine = m01.segments.find((s) => s.text.includes('Tomás Aguilar'))!;
    const alias = `s${m01.segments.indexOf(tomasLine) + 1}`;
    const answer = {
      meeting: { topics: [] },
      entities: [
        { ref: 'e1', type: 'Person', label: 'Tomás Aguilar', aliases: [], props: {}, evidence: [{ source: alias, quote: "I'm Tomás Aguilar" }] },
      ],
      relations: [],
      items: [],
    };
    const ai = stubAi(answer);
    const runner = createExtractRunner({ ai });

    const prediction = kgEvalPredictionSchema.parse(await runner.run(m01, { model: 'gpt-test', apiKey: 'sk-never-logged' }));

    const structuredCalls = ai.calls.filter((call) => call.method === 'generateStructured');
    expect(structuredCalls).toHaveLength(1);
    expect(structuredCalls[0]).toEqual(
      expect.objectContaining({
        ctx: expect.objectContaining({ feature: 'graph.extract' }),
        req: expect.objectContaining({
          target: expect.objectContaining({ model: 'gpt-test' }),
          schemaName: 'kg_extraction',
          jsonSchema: expect.any(Object),
        }),
      }),
    );
    expect(JSON.stringify(prediction)).not.toContain('sk-never-logged');
    expect(prediction.model).toBe('gpt-test');

    const meeting = prediction.entities.find((e) => e.ref === 'meeting')!;
    expect(meeting).toEqual(expect.objectContaining({ type: 'Meeting', label: m01.title }));
    const attended = prediction.relations.filter((r) => r.type === 'ATTENDED');
    expect(attended.map((r) => r.from).sort()).toEqual(['e1', 'g-person-alex-rivera', 'g-person-priya-raman', 'g-person-sarah-chen']);
    expect(prediction.entities.find((e) => e.ref === 'e1')!.evidence).toEqual([
      { source: 'segment', segmentId: tomasLine.id, quote: "I'm Tomás Aguilar" },
    ]);

    // The scorer sees the Meeting and every ATTENDED as true positives.
    const score = scoreFixture(m01, prediction);
    expect(score.types.Meeting).toEqual({ tp: 1, fp: 0, fn: 0 });
    expect(score.types['relation:ATTENDED']).toEqual({ tp: 4, fp: 0, fn: 0 });
    expect(score.evidence.valid).toBe(score.evidence.total);
  });

  it('an answer that is not the extraction format scores as an empty prediction', async () => {
    const prediction = await createExtractRunner({ ai: stubAi({ entities: 'nope' }) }).run(m01, { model: 'gpt-test', apiKey: 'k' });
    expect(prediction).toEqual(expect.objectContaining({ entities: [], relations: [], items: [], stats: { invalidOutput: 1 } }));
  });
});
