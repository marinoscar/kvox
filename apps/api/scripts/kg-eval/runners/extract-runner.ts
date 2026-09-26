// =============================================================================
// The `extract` kg:eval runner (#363; docs/specs/ontology.md §6)
// =============================================================================
//
// Runs `kg.extract`'s own pure pipeline against one golden fixture, with NO
// database: fixture → `ExtractionInput` → `buildExtractionContext` →
// `assembleExtractionPrompt` + `buildExtractionOutputSchema` → ONE
// `generateStructured` call on the OpenAI provider with the key from
// `KG_EVAL_OPENAI_API_KEY` → `validateExtraction` → the deterministic Meeting
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
// ⚠ The API key reaches the provider context only; it is never logged and
// never written into a prediction (which carries `model` alone).
// =============================================================================

import { computeEffectiveSchema } from '@app/shared/ontology';

import { AiProviderRegistry } from '../../../src/ai/ai-provider.registry';
import { DEFAULT_SYSTEM_SETTINGS } from '../../../src/common/types/settings.types';
import { createProviderContext, type AiProvider } from '../../../src/ai/providers/ai-provider.interface';
import { OpenAiProvider } from '../../../src/ai/providers/openai.provider';
import {
  buildExtractionContext,
  normalizeForMatch,
  type ExtractionInput,
  type KnownEntityRow,
} from '../../../src/graph/extraction/extraction-context';
import { EXTRACTION_SCHEMA_NAME, buildExtractionOutputSchema } from '../../../src/graph/extraction/output-schema';
import { applyPrecheck, type PrecheckItem } from '../../../src/graph/extraction/precheck';
import { assembleExtractionPrompt } from '../../../src/graph/extraction/prompt';
import { addDeterministicRows, validateExtraction, type EvidenceDraft, type ProposedRow } from '../../../src/graph/extraction/validate';
import { GRAPH_PREFERENCE_DEFAULTS } from '../../../src/graph/preferences/graph-preferences.defaults';
import type { EndpointRef } from '../../../src/graph/proposals/proposal-payload.schema';
import type { GoldenFixture } from '../fixture-schema';
import type { KgEvalPrediction, PredictedEvidence } from '../prediction-schema';
import type { KgEvalRunner, KgEvalRunOptions } from '../runner';

/** The completion ceiling an eval run uses (a production run takes it from policy). */
export const EVAL_MAX_OUTPUT_TOKENS = 16_000;
export const EVAL_TIMEOUT_MS = 180_000;

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
    effectiveSchema: computeEffectiveSchema({ enabledDomains: ['core', 'work'], userAttributes: [] }),
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
  /** The provider to call. Defaults to this build's OpenAI provider. */
  provider?: AiProvider<unknown>;
}

export function createExtractRunner(deps: ExtractRunnerDeps = {}): KgEvalRunner {
  const provider = deps.provider ?? (new OpenAiProvider(new AiProviderRegistry()) as unknown as AiProvider<unknown>);
  return {
    name: 'extract',
    async run(fixture: GoldenFixture, opts: KgEvalRunOptions): Promise<KgEvalPrediction> {
      if (typeof provider.generateStructured !== 'function') {
        throw new Error(`Provider "${provider.id}" cannot return structured output`);
      }
      const ctx = buildExtractionContext(fixtureToInput(fixture));
      const prompt = assembleExtractionPrompt(ctx);
      const schema = buildExtractionOutputSchema(ctx);
      // This build's default provider settings (the OpenAI API root), with the
      // model the run names permitted — nothing a deployment's settings add.
      const defaults = (DEFAULT_SYSTEM_SETTINGS.ai.providers as Record<string, Record<string, unknown>>)[provider.id] ?? {};
      const settings = provider.settingsSchema.parse({ ...defaults, allowedModels: [opts.model], defaultModel: opts.model });
      const result = await provider.generateStructured(createProviderContext(opts.apiKey, settings), {
        model: opts.model,
        systemPrompt: prompt.systemPrompt,
        userContent: prompt.userContent,
        schema,
        schemaName: EXTRACTION_SCHEMA_NAME,
        maxOutputTokens: EVAL_MAX_OUTPUT_TOKENS,
        timeoutMs: EVAL_TIMEOUT_MS,
      });

      const validated = validateExtraction(result.value, ctx);
      if (!validated.ok) {
        return { fixtureId: fixture.id, model: opts.model, entities: [], relations: [], items: [], stats: { invalidOutput: 1 } };
      }
      const final = addDeterministicRows(ctx, validated);
      const precheck: PrecheckItem[] = final.rows.map((row) => ({
        kind: row.kind,
        payload: row.payload as unknown as Record<string, unknown>,
        resolution: row.resolution,
        flags: row.flags,
        decision: 'pending',
      }));
      applyPrecheck(precheck, GRAPH_PREFERENCE_DEFAULTS);
      return rowsToPrediction(
        fixture.id,
        opts.model,
        final.rows,
        precheck.map((p) => p.decision),
        { ...final.stats.dropped, quoteNotLocated: final.stats.quoteNotLocated },
      );
    },
  };
}
