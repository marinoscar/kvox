// =============================================================================
// The `extract` kg:eval runner (#363; docs/specs/ontology.md §6)
// =============================================================================
//
// Runs `kg.extract`'s own pure pipeline against one golden fixture, with NO
// database: fixture → `ExtractionInput` → `buildExtractionContext` →
// `assembleExtractionPrompt` + `buildExtractionOutputSchema` → ONE
// `KVOX_AI.generateStructured` call (a direct client holding the key from
// `KG_EVAL_OPENAI_API_KEY`, or a fake in a test) → `validateExtraction` → the deterministic Meeting
// and ATTENDED rows → `applyPrecheck` (default preferences) → a prediction.
//
// It is the production code path minus the loader and the writer, so a score
// measures the prompt, the schema and the validator the product ships.
//
// A fixture's speaker is treated as IDENTIFIED_AS the known Person whose label
// or alias is its display name — what #356's speaker naming produces — so the
// known-entity priority and the ATTENDED rows behave as they would in the app.
// The golden set labels its own Meeting entity (key `meeting`); the runner
// emits the deterministic Meeting row under the same ref.
//
// ⚠ The API key reaches the direct client only (`direct-structured.ts`); it is
// never logged and never written into a prediction (which carries `model` alone).
// =============================================================================

import { computeEffectiveSchema } from '@app/shared/ontology';
import { z } from 'zod';

import { buildExtractionContext, normalizeForMatch, type ExtractionInput, type KnownEntityRow, EXTRACTION_SCHEMA_NAME, buildExtractionOutputSchema, assembleExtractionPrompt, extractionRowCaps, addDeterministicRows, validateExtraction, type EvidenceDraft, type ProposedRow } from '../../../test/graph/package-internals';
import { applyPrecheck, reviewOnlyTypes, type PrecheckItem } from '@marinoscar/kvox-api/graph-extraction';
import { GRAPH_PREFERENCE_DEFAULTS } from '@marinoscar/kvox-api/graph';
import type { EndpointRef } from '@marinoscar/kvox-contract/graph';
import { directStructuredClient, type KgEvalAi } from '../direct-structured';
import { fixtureDomains } from '../domains';
import type { GoldenFixture } from '../fixture-schema';
import type { KgEvalPrediction, PredictedEvidence } from '../prediction-schema';
import type { KgEvalRunner, KgEvalRunOptions } from '../runner';

/** The completion ceiling an eval run uses (a production run takes it from policy). */
export const EVAL_MAX_OUTPUT_TOKENS = 16_000;
export const EVAL_TIMEOUT_MS = 180_000;
/** The context window an eval target reports (the direct client never reads it; the port's target carries one). */
export const EVAL_CONTEXT_WINDOW_TOKENS = 128_000;
/** The user id an eval call carries (there is no signed-in user). */
export const EVAL_USER_ID = 'kg-eval';

/** The one fixture → input mapping. Pure. */
export function fixtureToInput(fixture: GoldenFixture): ExtractionInput {
  const recordedAt = new Date(fixture.recordedAt);
  const known: KnownEntityRow[] = fixture.knownEntities.map((k) => ({
    id: k.id,
    type: k.type,
    label: k.label,
    aliases: [...k.aliases],
    reviewStatus: 'accepted',
    mergedIntoId: null,
    orgLabel: null,
  }));
  const personFor = (name: string | null): string | null => {
    if (!name) return null;
    const n = normalizeForMatch(name);
    const hit = known.find((k) => k.type === 'Person' && [k.label, ...k.aliases].some((a) => normalizeForMatch(a) === n));
    return hit?.id ?? null;
  };
  const speakers = fixture.hasTranscript
    ? fixture.speakers.map((s) => ({ id: s.id, label: s.label, displayName: s.displayName, personEntityId: personFor(s.displayName) }))
    : [];
  const linked = new Set(speakers.map((s) => s.personEntityId).filter((id): id is string => id !== null));

  return {
    note: {
      id: `${fixture.id}-note`,
      title: fixture.title,
      bodyAtVersion: fixture.note.body,
      version: fixture.note.version,
      contextText: fixture.contextText,
      createdAt: recordedAt,
    },
    transcript: fixture.hasTranscript
      ? { id: `${fixture.id}-transcript`, title: fixture.title, recordedAt, createdAt: recordedAt }
      : null,
    segments: fixture.hasTranscript
      ? fixture.segments.map((s) => ({ id: s.id, rev: s.rev, startMs: s.startMs, endMs: s.endMs, speakerId: s.speakerId, text: s.text }))
      : [],
    speakers,
    effectiveSchema: computeEffectiveSchema({ enabledDomains: fixtureDomains(fixture), userAttributes: [] }),
    guidance: null,
    knownEntityCandidates: {
      pinned: [],
      speakerPersons: known.filter((k) => linked.has(k.id)),
      organizations: [],
      contextPool: known,
      recentlyMentioned: known,
    },
    existingMeeting: null,
  };
}

const endpoint = (ref: EndpointRef | null): string | null => (ref === null ? null : 'entityId' in ref ? ref.entityId : ref.ref);

const evidenceOf = (row: ProposedRow): PredictedEvidence[] =>
  row.evidence.map((e: EvidenceDraft) =>
    e.source === 'segment'
      ? { source: 'segment', segmentId: e.segmentId, quote: e.quote }
      : { source: 'note', segmentId: null, quote: e.quote },
  );

/** Proposal rows (with their pre-check decisions) → a kg:eval prediction. Pure. */
export function rowsToPrediction(
  fixtureId: string,
  model: string | null,
  rows: ProposedRow[],
  decisions: string[],
  stats: Record<string, number>,
): KgEvalPrediction {
  const prediction: KgEvalPrediction = { fixtureId, model, entities: [], relations: [], items: [], stats };
  rows.forEach((row, i) => {
    const prechecked = decisions[i] === 'accept';
    if (row.kind === 'entity') {
      const linked = row.resolution?.ref ?? null;
      prediction.entities.push({
        ref: row.payload.ref,
        type: row.payload.type,
        label: row.payload.label,
        aliases: [...row.payload.aliases],
        resolution: linked
          ? { outcome: 'linked', entityId: linked, score: row.resolution?.score ?? null, prechecked }
          : { outcome: 'new', entityId: null, score: null, prechecked },
        evidence: evidenceOf(row),
      });
    } else if (row.kind === 'relation') {
      prediction.relations.push({
        type: row.payload.type,
        from: endpoint(row.payload.from) as string,
        to: endpoint(row.payload.to) as string,
        validFrom: row.payload.validFrom,
        validTo: row.payload.validTo,
        precision: row.payload.precision,
        evidence: evidenceOf(row),
      });
    } else {
      prediction.items.push({
        kind: row.payload.kind,
        subject: endpoint(row.payload.subject) ?? '',
        owner: endpoint(row.payload.owner),
        counterparty: endpoint(row.payload.counterparty),
        title: row.payload.title,
        statement: row.payload.statement,
        occurredAt: row.payload.occurredAt,
        dueAt: row.payload.dueAt,
        sensitivity: row.payload.sensitivity,
        evidence: evidenceOf(row),
      });
    }
  });
  return prediction;
}

export interface ExtractRunnerDeps {
  /**
   * The model port to call. Defaults to a direct OpenAI client holding the run's
   * key (`opts.apiKey`); a test passes a fake.
   */
  ai?: KgEvalAi;
}

/**
 * The shared half of every runner: one `generateStructured` call and the
 * validator, returning the proposal rows before any pre-check. `null` when the
 * model's answer fails validation (`invalidOutput`). #364's `extract+resolve`
 * runner resolves these rows before the pre-check runs.
 */
export async function runExtraction(
  ai: KgEvalAi,
  fixture: GoldenFixture,
  opts: KgEvalRunOptions,
): Promise<{ rows: ProposedRow[]; stats: Record<string, number> } | null> {
  const ctx = buildExtractionContext(fixtureToInput(fixture));
  // The row caps a production run at this ceiling would send (#435).
  const caps = extractionRowCaps(EVAL_MAX_OUTPUT_TOKENS, 'none');
  const prompt = assembleExtractionPrompt(ctx, caps);
  const schema = buildExtractionOutputSchema(ctx, caps);
  // `schema` is the pass-through validator: `validateExtraction` below is the
  // product's own validation, exactly as in the `kg.extract` handler.
  const result = await ai.generateStructured(
    { userId: EVAL_USER_ID, orgId: null, feature: 'graph.extract', signal: AbortSignal.timeout(EVAL_TIMEOUT_MS) },
    {
      target: {
        provider: 'openai',
        model: opts.model,
        contextWindowTokens: EVAL_CONTEXT_WINDOW_TOKENS,
        maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
        source: 'requested',
      },
      system: prompt.systemPrompt,
      user: prompt.userContent,
      schemaName: EXTRACTION_SCHEMA_NAME,
      schema: z.unknown(),
      jsonSchema: schema,
      maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
    },
  );

  const validated = validateExtraction(result.value, ctx);
  if (!validated.ok) return null;
  const final = addDeterministicRows(ctx, validated);
  return { rows: final.rows, stats: { ...final.stats.dropped, quoteNotLocated: final.stats.quoteNotLocated } };
}

const ALL_DOMAINS_REVIEW_ONLY = reviewOnlyTypes(
  computeEffectiveSchema({ enabledDomains: ['core', 'work', 'personal'], userAttributes: [] }),
);

/** Pre-check the rows with default preferences and turn them into a prediction. */
export function precheckToPrediction(fixtureId: string, model: string, rows: ProposedRow[], stats: Record<string, number>): KgEvalPrediction {
  const precheck: PrecheckItem[] = rows.map((row) => ({
    kind: row.kind,
    payload: row.payload as unknown as Record<string, unknown>,
    resolution: row.resolution,
    flags: row.flags,
    decision: 'pending',
  }));
  // Every domain's review-only types: a type a fixture's domains do not
  // include can never have been proposed, so listing it changes nothing.
  applyPrecheck(precheck, GRAPH_PREFERENCE_DEFAULTS, { reviewOnlyTypes: ALL_DOMAINS_REVIEW_ONLY });
  return rowsToPrediction(fixtureId, model, rows, precheck.map((p) => p.decision), stats);
}

export function createExtractRunner(deps: ExtractRunnerDeps = {}): KgEvalRunner {
  return {
    name: 'extract',
    async run(fixture: GoldenFixture, opts: KgEvalRunOptions): Promise<KgEvalPrediction> {
      const extracted = await runExtraction(deps.ai ?? directStructuredClient(opts.apiKey), fixture, opts);
      if (!extracted) {
        return { fixtureId: fixture.id, model: opts.model, entities: [], relations: [], items: [], stats: { invalidOutput: 1 } };
      }
      return precheckToPrediction(fixture.id, opts.model, extracted.rows, extracted.stats);
    },
  };
}
