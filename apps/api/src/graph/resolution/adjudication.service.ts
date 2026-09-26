// =============================================================================
// AdjudicationService (#364, epic #346; docs/specs/ontology.md §7, §15, §20)
// =============================================================================
//
// The middle band's verdict: for each (mention, top candidate) pair whose
// score sits between `newThreshold` and `autoLinkThreshold`, ask the
// `graph.adjudicate` task model `same | different | uncertain`.
//
//   model     `AiTaskModelResolver.resolve(userId, 'graph.adjudicate')` — never
//             an extraction run's override, which applies to `graph.extract`
//   batching  ≤ 20 pairs per `generateStructured` call (`kg_adjudication`)
//   throttle  `aiProviderThrottleKey(userId)` registered for the CALLING job's
//             type immediately before each call; a `RateLimitError` propagates
//             (it defers the whole `kg.extract` / `kg.resolve` job)
//   answers   a verdict for an unknown pair id is ignored; a pair with no
//             verdict is `uncertain` — never pre-checked downstream
//
// Dossiers (`buildCandidateDossiers`) carry the owner's own entity, alias,
// relation and entity-evidence rows only — never a `kg_items` statement, so a
// `sensitive` PersonFact can never reach the prompt (§5.6, §15).
//
// ⚠ Logs carry ids, counts and the model id — never a label, a quote or a
// rationale.
// =============================================================================

import { Injectable } from '@nestjs/common';

import { AiAuthError, AiInputError } from '../../ai/ai-errors';
import { AiTaskModelResolver } from '../../ai/ai-task-model-resolver.service';
import { createProviderContext } from '../../ai/providers/ai-provider.interface';
import { UserAiCredentialsService } from '../../ai/user-ai-credentials.service';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { extractionBudget } from '../extraction/graph-extraction.service';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import {
  ADJUDICATION_BATCH_SIZE,
  ADJUDICATION_MAX_NEIGHBOURHOOD_LINES,
  ADJUDICATION_MAX_QUOTES,
  ADJUDICATION_SCHEMA_NAME,
  buildAdjudicationOutputSchema,
  buildAdjudicationSystemPrompt,
  buildAdjudicationUserContent,
  readVerdicts,
  type AdjudicationPair,
  type AdjudicationTypeInfo,
  type AdjudicationVerdict,
  type CandidateDossier,
} from './adjudication-prompt';

export const ADJUDICATION_MAX_OUTPUT_TOKENS = 4_000;

export interface AdjudicationResult {
  verdict: AdjudicationVerdict;
  rationale: string;
  model: string;
}

export interface AdjudicateOptions {
  /** The job type the calling job runs under — the throttle key is registered for it. */
  jobType: string;
}

const LIVE = ['accepted', 'edited'] as const;

function formatYears(y0: number | null, y1: number | null): string {
  if (y0 === null && y1 === null) return '';
  return ` (${y0 ?? ''}–${y1 ?? ''})`;
}

@Injectable()
export class AdjudicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly resolver: AiTaskModelResolver,
    private readonly credentials: UserAiCredentialsService,
    private readonly throttle: ProviderThrottleService,
    private readonly ontology: GraphOntologyService,
  ) {}

  /**
   * Verdicts keyed by `pairId`. Throws the resolver's refusal (graph off, no
   * key, no capable model), a provider error, or a `RateLimitError` — the
   * caller decides which of those degrade to "no adjudication".
   */
  async adjudicate(
    userId: string,
    pairs: readonly AdjudicationPair[],
    options: AdjudicateOptions,
  ): Promise<Map<string, AdjudicationResult>> {
    const out = new Map<string, AdjudicationResult>();
    if (pairs.length === 0) return out;

    const resolution = await this.resolver.resolve(userId, 'graph.adjudicate');
    const provider = resolution.provider;
    if (typeof provider.generateStructured !== 'function') {
      throw new AiInputError(
        `The "${provider.id}" provider cannot return structured output, which adjudication needs.`,
        undefined,
        provider.id,
      );
    }
    const settings = provider.settingsSchema.safeParse(
      (resolution.policy.providers as Record<string, unknown>)[provider.id] ?? {},
    );
    if (!settings.success) {
      throw new AiInputError(`This deployment's configuration for provider "${provider.id}" is invalid.`, undefined, provider.id);
    }
    const apiKey = await this.credentials.getSecret(userId, provider.id);
    if (!apiKey) throw new AiAuthError(`No ${provider.label} API key is saved for your account.`, provider.id);

    const schema = await this.ontology.effectiveSchemaFor(userId);
    const typeKeys = [...new Set(pairs.map((p) => p.type))].sort();
    const types: AdjudicationTypeInfo[] = typeKeys.map((key) => {
      const t = schema.entityType(key);
      return { key, label: t?.label, description: t?.description ?? '', disambiguation: t?.disambiguation ?? [] };
    });
    const maxOutputTokens = Math.min(ADJUDICATION_MAX_OUTPUT_TOKENS, extractionBudget(resolution).maxOutputTokens);
    const outputSchema = buildAdjudicationOutputSchema();

    for (let i = 0; i < pairs.length; i += ADJUDICATION_BATCH_SIZE) {
      const batch = pairs.slice(i, i + ADJUDICATION_BATCH_SIZE);
      const batchTypes = types.filter((t) => batch.some((p) => p.type === t.key));
      this.throttle.registerProviderKey(options.jobType, aiProviderThrottleKey(userId));
      const result = await provider.generateStructured(createProviderContext(apiKey, settings.data as never), {
        model: resolution.model,
        systemPrompt: buildAdjudicationSystemPrompt(batchTypes),
        userContent: buildAdjudicationUserContent(batch),
        schema: outputSchema,
        schemaName: ADJUDICATION_SCHEMA_NAME,
        maxOutputTokens,
        timeoutMs: resolution.policy.requestTimeoutMs,
        reasoningEffort: resolution.reasoningEffort,
      });
      const verdicts = readVerdicts(result.value, new Set(batch.map((p) => p.pairId)));
      for (const pair of batch) {
        const v = verdicts.get(pair.pairId);
        out.set(pair.pairId, {
          verdict: v?.verdict ?? 'uncertain',
          rationale: v?.rationale ?? 'The model gave no verdict for this pair.',
          model: resolution.model,
        });
      }
    }
    return out;
  }

  /**
   * One dossier per candidate id: label, aliases, props, a ≤ 15-line 1–2-hop
   * neighbourhood and ≤ 3 entity-evidence quotes. Owner-scoped; ids the owner
   * does not own simply produce no dossier.
   */
  async buildCandidateDossiers(ownerId: string, entityIds: readonly string[]): Promise<Map<string, CandidateDossier>> {
    const ids = [...new Set(entityIds)];
    const out = new Map<string, CandidateDossier>();
    if (ids.length === 0) return out;

    const [entities, aliases, evidence] = await Promise.all([
      this.prisma.kgEntity.findMany({ where: { id: { in: ids }, ownerId }, select: { id: true, label: true, props: true } }),
      this.prisma.kgEntityAlias.findMany({
        where: { entityId: { in: ids }, ownerId },
        select: { entityId: true, alias: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.kgEvidence.findMany({
        where: { ownerId, subjectKind: 'entity', subjectId: { in: ids } },
        select: { subjectId: true, quote: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    ]);

    const hood = await this.neighbourhoods(ownerId, ids);
    for (const e of entities) {
      out.set(e.id, {
        entityId: e.id,
        label: e.label,
        aliases: aliases.filter((a) => a.entityId === e.id).map((a) => a.alias),
        props: (e.props ?? {}) as Record<string, unknown>,
        quotes: evidence.filter((q) => q.subjectId === e.id).slice(0, ADJUDICATION_MAX_QUOTES).map((q) => q.quote),
        neighbourhood: hood.get(e.id) ?? [],
      });
    }
    return out;
  }

  /** `TYPE → Label (y0–y1)` lines, 1-hop first, then 2-hop, ≤ 15 per entity. */
  private async neighbourhoods(ownerId: string, ids: string[]): Promise<Map<string, string[]>> {
    type Edge = { type: string; from_id: string | null; to_id: string; y0: number | null; y1: number | null };
    const edgesOf = async (entityIds: string[]): Promise<Edge[]> =>
      entityIds.length === 0
        ? []
        : this.prisma.$queryRaw<Edge[]>`
            SELECT r.type, r.from_id::text AS from_id, r.to_id::text AS to_id,
                   extract(year FROM lower(r.valid))::int AS y0,
                   extract(year FROM upper(r.valid))::int AS y1
              FROM kg_relations r
             WHERE r.owner_id = ${ownerId}::uuid
               AND r.review_status IN ('accepted', 'edited')
               AND (r.from_id = ANY(${entityIds}::uuid[]) OR r.to_id = ANY(${entityIds}::uuid[]))
             ORDER BY r.created_at, r.id
             LIMIT 2000`;

    const first = await edgesOf(ids);
    const hop1 = new Map<string, Array<{ other: string; line: (label: string) => string }>>();
    const otherIds = new Set<string>();
    for (const e of first) {
      for (const [self, other, arrow] of [
        [e.from_id, e.to_id, '→'],
        [e.to_id, e.from_id, '←'],
      ] as const) {
        if (!self || !other || !ids.includes(self) || self === other) continue;
        otherIds.add(other);
        const list = hop1.get(self) ?? [];
        list.push({ other, line: (label) => `${e.type} ${arrow} ${label}${formatYears(e.y0, e.y1)}` });
        hop1.set(self, list);
      }
    }
    const second = await edgesOf([...otherIds].filter((id) => !ids.includes(id)));
    for (const e of second) {
      if (e.from_id) otherIds.add(e.from_id);
      otherIds.add(e.to_id);
    }
    const labels = new Map(
      (
        await this.prisma.kgEntity.findMany({
          where: { id: { in: [...otherIds] }, ownerId, reviewStatus: { in: [...LIVE] } },
          select: { id: true, label: true },
        })
      ).map((r) => [r.id, r.label]),
    );

    const out = new Map<string, string[]>();
    for (const id of ids) {
      const lines: string[] = [];
      const neighbours = (hop1.get(id) ?? []).filter((n) => labels.has(n.other));
      for (const n of neighbours) lines.push(n.line(labels.get(n.other)!));
      for (const n of neighbours) {
        if (lines.length >= ADJUDICATION_MAX_NEIGHBOURHOOD_LINES) break;
        for (const e of second) {
          if (lines.length >= ADJUDICATION_MAX_NEIGHBOURHOOD_LINES) break;
          const via = labels.get(n.other)!;
          if (e.from_id === n.other && e.to_id !== id && labels.has(e.to_id)) {
            lines.push(`${via}: ${e.type} → ${labels.get(e.to_id)}${formatYears(e.y0, e.y1)}`);
          } else if (e.to_id === n.other && e.from_id && e.from_id !== id && labels.has(e.from_id)) {
            lines.push(`${via}: ${e.type} ← ${labels.get(e.from_id)}${formatYears(e.y0, e.y1)}`);
          }
        }
      }
      out.set(id, [...new Set(lines)].slice(0, ADJUDICATION_MAX_NEIGHBOURHOOD_LINES));
    }
    return out;
  }
}
