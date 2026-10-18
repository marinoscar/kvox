import { scenarioStructuredAnswer, type KvoxScenarioMeeting } from '../../testing/index.js';
import { makeContext } from '../testing/extraction-fixtures.js';
import { assembleExtractionPrompt } from './prompt.js';
import { addDeterministicRows, validateExtraction } from './validate.js';

// =============================================================================
// The testing kit's scenario model (`@marinoscar/kvox-api/testing`) against the
// REAL extraction prompt and validator: a host's end-to-end test relies on it
// reading `assembleExtractionPrompt`'s shapes, so they are pinned together here.
// The fixture's speaker A is identified ("Sarah Chen", known as k1), so its
// transcript lines carry a real name rather than "Speaker A".
// =============================================================================

const ctx = makeContext();
const { userContent } = assembleExtractionPrompt(ctx);

function meeting(attended: boolean): KvoxScenarioMeeting {
  return {
    title: ctx.meetingTitle,
    people: [{ label: 'Sarah Chen', quote: "I'm Sarah Chen", attended }],
    relations: [],
    commitments: [
      {
        owner: 'Sarah Chen',
        counterparty: null,
        title: 'Send the updated proposal',
        statement: 'Sarah Chen will send the updated proposal by Friday.',
        status: 'open',
        quote: "I'll send the updated proposal by Friday.",
      },
    ],
  };
}

describe('scenarioStructuredAnswer against the real kg_extraction prompt', () => {
  it('reads named speaker lines and known entities, and the validator accepts the answer', () => {
    expect(userContent).toContain("s3 [00:12:03] Sarah Chen: I'll send the updated proposal by Friday.");
    const answer = scenarioStructuredAnswer('kg_extraction', userContent, [meeting(true)]) as Record<string, any>;

    // Sarah is a known entity: answered with her k#, never proposed again.
    expect(answer.entities).toEqual([]);
    expect(answer.items[0]).toMatchObject({ owner: 'k1', evidence: [{ source: 's3' }] });
    expect(answer.relations).toEqual([expect.objectContaining({ type: 'ATTENDED', from: 'k1', to: 'meeting', evidence: [{ source: 's1', quote: "I'm Sarah Chen" }] })]);

    const result = validateExtraction(answer, ctx);
    expect(result.ok).toBe(true);
  });

  it('with attended: false, the only ATTENDED row is the slice\'s deterministic one for the identified speaker', () => {
    const answer = scenarioStructuredAnswer('kg_extraction', userContent, [meeting(false)]) as Record<string, any>;
    expect(answer.relations).toEqual([]);

    const result = validateExtraction(answer, ctx);
    if (!result.ok) throw new Error(result.message);
    const rows = addDeterministicRows(ctx, result).rows;
    const attended = rows.filter((r) => r.kind === 'relation' && r.payload.type === 'ATTENDED');
    expect(attended).toHaveLength(1);
  });

  it('extracts nothing for a meeting the scenario does not know', () => {
    expect(scenarioStructuredAnswer('kg_extraction', userContent, [])).toEqual({
      meeting: { topics: [] },
      entities: [],
      relations: [],
      items: [],
    });
  });
});
