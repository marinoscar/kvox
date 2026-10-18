import type { AiResponse, AiResponseRequest, AiStreamEvent } from '@marinoscar/platform-api/ai';
import { completedEvent, functionCallEvent, textAnswer, type RecordingScript } from '@marinoscar/kvox-ai/testing';

import { loadGoldenMeetings, type GoldenFixture } from '../fixtures/index.js';
import { buildExtractionContext, type ExtractionContext } from './internals.js';
import { fixtureToInput } from '../kg/index.js';

// =============================================================================
// The scripted provider of the parity scenario (issue #580, part 2)
// =============================================================================
//
// A model is only as deterministic as its script. This one is a PURE FUNCTION OF
// THE REQUEST (and of the fixture the scenario says it is on), so the same script
// answers identically behind the direct binding's adapter and behind the web
// binding's fake platform client. That is what makes the later requests of a run
// comparable: the extraction answer feeds nothing back, but an Ask step's tool
// result does, and both bindings must see the same one.
//
//   notes generation    a fixed paragraph.
//   kg_extraction       the fixture's own gold labels as the model's raw answer,
//                       so what is extracted (and then adjudicated) is real.
//   kg_adjudication     a verdict for every pair id in the prompt.
//   Ask                 a `search` tool call, then (once its result is in the
//                       history) a short cited answer.
// =============================================================================

/**
 * The scripted provider: a `RecordingScript` (of `@marinoscar/kvox-ai/testing`) that also needs to know which golden meeting the scenario is on.
 *
 * @stability experimental
 */
export interface ParityScript extends Required<Pick<RecordingScript, 'stream' | 'create'>> {
  /** The call id of the Ask tool call the script makes. */
  readonly toolCallId: string;
  /**
   * Tells the script which meeting the scenario is on; its extraction answer is that meeting's gold labels.
   *
   * @param fixtureId - a golden meeting id, or `null` between meetings (the Ask questions).
   */
  focus(fixtureId: string | null): void;
}

/** The id of the one tool call the script makes. */
const TOOL_CALL_ID = 'call_parity_1';

type Row = Record<string, unknown>;

/** The empty extraction answer. */
const EMPTY_ANSWER = { meeting: { topics: [] }, entities: [], relations: [], items: [] };

/**
 * The raw extraction answer a model that read the meeting perfectly would give: the
 * fixture's gold entities, relations and items, with the prompt's own `s#`, `N` and
 * `k#` ids. The Meeting entity and ATTENDED relations are the product's deterministic
 * rows, never the model's, so they are left out.
 *
 * @param fixture - the golden meeting.
 * @param ctx - the extraction context the prompt was built from.
 * @returns the answer in the extraction output schema's shape.
 * @stability experimental
 */
export function goldExtractionAnswer(fixture: GoldenFixture, ctx: ExtractionContext): Record<string, unknown> {
  const aliasOfSegment = new Map(ctx.segments.map((s) => [s.segmentId, s.alias]));
  const aliasOfKnown = new Map(ctx.knownEntities.map((k) => [k.id, k.alias]));
  const refOf = new Map<string, string>(
    fixture.labels.entities.map((e) => [e.key, e.existingId !== null && aliasOfKnown.has(e.existingId) ? aliasOfKnown.get(e.existingId)! : e.key]),
  );
  refOf.set('meeting', 'meeting');
  const end = (key: string | null): string | null => (key === null ? null : (refOf.get(key) ?? key));
  const cites = (evidence: GoldenFixture['labels']['entities'][number]['evidence']): Row[] =>
    evidence.map((e) => ({ source: e.source === 'segment' ? (aliasOfSegment.get(e.segmentId) ?? 'N') : 'N', quote: e.quote }));

  return {
    meeting: { topics: [fixture.title] },
    entities: fixture.labels.entities
      .filter((e) => e.type !== 'Meeting')
      .map((e) => ({ ref: refOf.get(e.key), type: e.type, label: e.label, aliases: [...e.aliases], props: e.props, evidence: cites(e.evidence) })),
    relations: fixture.labels.relations
      .filter((r) => r.type !== 'ATTENDED')
      .map((r) => ({
        type: r.type,
        from: end(r.from),
        to: end(r.to),
        props: r.props,
        validFrom: r.validFrom,
        validTo: r.validTo,
        precision: r.precision,
        evidence: cites(r.evidence),
      })),
    items: fixture.labels.items.map((i) => ({
      kind: i.kind,
      title: i.title,
      statement: i.statement,
      subject: end(i.subject),
      owner: end(i.owner),
      counterparty: end(i.counterparty),
      status: i.status,
      occurredAt: i.occurredAt,
      dueAt: i.dueAt,
      validFrom: null,
      validTo: null,
      precision: 'unknown',
      sensitivity: i.sensitivity,
      props: {},
      evidence: cites(i.evidence),
    })),
  };
}

/** The text of the last user message of an Ask request. */
function lastUserText(req: AiResponseRequest): string {
  if (typeof req.input === 'string') return req.input;
  for (let i = req.input.length - 1; i >= 0; i -= 1) {
    const item = req.input[i];
    if (item.type === 'message' && item.role === 'user') {
      return item.content.map((part) => ('text' in part ? String(part.text) : '')).join('');
    }
  }
  return '';
}

/**
 * Builds the scripted provider.
 *
 * @example
 * ```ts
 * const script = createParityScript();
 * const adapter = createRecordingAdapter(script);
 * await runParityScenario(ai, { fixtures: ['m01'], questions: [], script });
 * ```
 *
 * @returns the script.
 * @stability experimental
 */
export function createParityScript(): ParityScript {
  const fixtures = new Map<string, GoldenFixture>();
  let focused: string | null = null;

  const extractionAnswer = (): Record<string, unknown> => {
    if (focused === null) return EMPTY_ANSWER;
    if (!fixtures.has(focused)) for (const f of loadGoldenMeetings([focused])) fixtures.set(f.id, f);
    const fixture = fixtures.get(focused)!;
    return goldExtractionAnswer(fixture, buildExtractionContext(fixtureToInput(fixture)));
  };

  return {
    toolCallId: TOOL_CALL_ID,
    focus(fixtureId) {
      focused = fixtureId;
    },

    create(req): Partial<AiResponse> {
      const name = req.structuredOutput?.name;
      let parsed: unknown = { ok: true };
      if (name === 'kg_extraction') {
        parsed = extractionAnswer();
      } else if (name === 'kg_adjudication') {
        const text = typeof req.input === 'string' ? req.input : '';
        const ids = [...text.matchAll(/^## Pair (p\d+)/gm)].map((m) => m[1]);
        const verdicts = ['same', 'different', 'uncertain'] as const;
        parsed = { verdicts: ids.map((pairId, i) => ({ pairId, verdict: verdicts[i % verdicts.length], rationale: `Parity verdict for ${pairId}.` })) };
      }
      return { parsed, outputText: JSON.stringify(parsed) };
    },

    stream(req): AiStreamEvent[] {
      if (req.tools === undefined || req.tools.length === 0) {
        return textAnswer(`Parity note for ${focused ?? 'no meeting'}.\n\n- Everything said was written down once.`);
      }
      const hasResult = typeof req.input !== 'string' && req.input.some((item) => item.type === 'function_call_output');
      if (!hasResult) {
        const query = lastUserText(req).slice(0, 200) || 'parity';
        const item = { type: 'function_call' as const, callId: TOOL_CALL_ID, name: 'search', arguments: JSON.stringify({ query }) };
        return [functionCallEvent(item.callId, item.name, item.arguments), completedEvent({ output: [item], finishReason: 'tool_calls' })];
      }
      return textAnswer('The graph answers this directly and the search found it.[^ent1] That is the whole of what the parity script says.');
    },
  };
}
