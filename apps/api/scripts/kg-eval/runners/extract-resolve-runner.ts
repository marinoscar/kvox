// =============================================================================
// The `extract+resolve` kg:eval runner (#364; docs/specs/ontology.md §6, §7)
// =============================================================================
//
// `extract` (#363), then resolution of every proposed entity against the
// fixture's `knownEntities` — so auto-link PRECISION is measured, the number
// that gates any future lowering of the 0.90 default (#362's target).
//
// NO DATABASE: an in-memory implementation of the candidate arms feeds the
// production `score.ts` and `decide()`:
//
//   A  exact — `normalizeAlias` (#355) over label + aliases, as in SQL
//   B  trigram — a JS port of `pg_trgm`'s `similarity()` (lowercased words,
//      padded "  w ", trigram-set Jaccard), threshold 0.4
//   C  vector — skipped (no embeddings in an eval run)
//
// Context: `sameMeeting` for a known Person a fixture speaker is identified as
// (what #356 produces); the speaker shortcut links such a Person outright, as
// production does. Adjudication is OFF — the eval measures the deterministic
// bands; a middle-band row is `possible_duplicate` and never pre-checked.
//
// ⚠ The key reaches the provider context only (inside `runExtraction`).
// =============================================================================

import { AiProviderRegistry } from '../../../src/ai/ai-provider.registry';
import type { AiProvider } from '../../../src/ai/providers/ai-provider.interface';
import { OpenAiProvider } from '../../../src/ai/providers/openai.provider';
import { normalizeForMatch } from '../../../src/graph/extraction/extraction-context';
import type { ProposedRow } from '../../../src/graph/extraction/validate';
import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../../../src/graph/preferences/graph-preferences.defaults';
import { decide } from '../../../src/graph/resolution/resolution.service';
import { bandFor, rankCandidates, scoreCandidate } from '../../../src/graph/resolution/score';
import { normalizeAlias } from '../../../src/graph/write/normalize';
import type { GoldenFixture } from '../fixture-schema';
import type { KgEvalPrediction } from '../prediction-schema';
import type { KgEvalRunner, KgEvalRunOptions } from '../runner';
import { fixtureToInput, precheckToPrediction, runExtraction, type ExtractRunnerDeps } from './extract-runner';

const TRIGRAM_THRESHOLD = 0.4;

function trigrams(text: string): Set<string> {
  const out = new Set<string>();
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    const padded = `  ${word} `;
    for (let i = 0; i + 3 <= padded.length; i += 1) out.add(padded.slice(i, i + 3));
  }
  return out;
}

/** `pg_trgm`'s `similarity(a, b)`: shared trigrams over the union. */
export function trigramSimilarity(a: string, b: string): number {
  const x = trigrams(a);
  const y = trigrams(b);
  if (x.size === 0 || y.size === 0) return 0;
  let shared = 0;
  for (const t of x) if (y.has(t)) shared += 1;
  return shared / (x.size + y.size - shared);
}

function safeNormalize(name: string): string | null {
  try {
    return normalizeAlias(name);
  } catch {
    return null;
  }
}

/**
 * PURE. Resolve every proposed entity row (in place, on copies) against the
 * fixture's known entities. The Meeting row and anything without a type match
 * keep what extraction decided.
 */
export function resolveRowsInMemory(
  fixture: GoldenFixture,
  rows: readonly ProposedRow[],
  prefs: GraphPreferences = GRAPH_PREFERENCE_DEFAULTS,
): ProposedRow[] {
  const input = fixtureToInput(fixture);
  const speakerPersons = new Set(input.speakers.map((s) => s.personEntityId).filter((id): id is string => !!id));
  const personBySpeakerName = new Map(
    input.speakers.filter((s) => s.personEntityId && s.displayName).map((s) => [normalizeForMatch(s.displayName!), s.personEntityId!]),
  );
  const known = fixture.knownEntities.map((k) => ({
    ...k,
    names: [k.label, ...k.aliases],
    normalized: new Set([k.label, ...k.aliases].map(safeNormalize).filter((n): n is string => n !== null)),
  }));

  return rows.map((row) => {
    if (row.kind !== 'entity' || row.payload.ref === 'meeting' || row.resolution?.source === 'meeting') return row;
    const p = row.payload;

    if (p.type === 'Person') {
      const speakerPerson = [p.label, ...p.aliases].map((n) => personBySpeakerName.get(normalizeForMatch(n))).find(Boolean);
      if (speakerPerson) {
        return { ...row, resolution: { ref: speakerPerson, score: 1, source: 'speaker' as const, candidates: [], adjudication: null } };
      }
    }

    const mentionNames = [p.label, ...p.aliases].map(safeNormalize).filter((n): n is string => n !== null);
    const scored = known
      .filter((k) => k.type === p.type)
      .map((k) => {
        const aliasExact = mentionNames.some((n) => k.normalized.has(n));
        const best = Math.max(0, ...k.names.map((n) => trigramSimilarity(p.label, n)));
        return {
          entityId: k.id,
          label: k.label,
          type: k.type,
          ...scoreCandidate({
            aliasExact,
            trigram: best >= TRIGRAM_THRESHOLD ? best : null,
            cosine: null,
            sameMeeting: speakerPersons.has(k.id),
            orgCoMention: false,
            sharedNeighbour: false,
            recent: false,
          }),
        };
      })
      .filter((c) => c.arm !== null);
    const ranked = rankCandidates(scored, prefs.resolution);
    const decision = decide(
      { candidates: ranked.candidates, ambiguous: ranked.ambiguous, band: bandFor(ranked.candidates[0]?.score ?? null, prefs.resolution) },
      prefs.resolution,
      null,
    );
    return { ...row, resolution: decision.resolution, flags: [...new Set([...row.flags, ...decision.flags])] } as ProposedRow;
  });
}

export function createExtractResolveRunner(deps: ExtractRunnerDeps = {}): KgEvalRunner {
  const provider = deps.provider ?? (new OpenAiProvider(new AiProviderRegistry()) as unknown as AiProvider<unknown>);
  return {
    name: 'extract+resolve',
    async run(fixture: GoldenFixture, opts: KgEvalRunOptions): Promise<KgEvalPrediction> {
      const extracted = await runExtraction(provider, fixture, opts);
      if (!extracted) {
        return { fixtureId: fixture.id, model: opts.model, entities: [], relations: [], items: [], stats: { invalidOutput: 1 } };
      }
      const resolved = resolveRowsInMemory(fixture, extracted.rows);
      return precheckToPrediction(fixture.id, opts.model, resolved, extracted.stats);
    },
  };
}
