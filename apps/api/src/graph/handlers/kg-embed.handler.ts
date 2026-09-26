// =============================================================================
// kg.embed (#364, epic #346; docs/specs/ontology.md §7, §11, §15)
// =============================================================================
//
// Profile embeddings for entities and items — the vectors resolution's kNN
// arm and later retrieval search. One batch of ids in, one `provider.embed`
// call (chunked at the provider's own batch ceiling) out.
//
//   profile   { maxRuntimeMs: 5 min, maxAttempts: 3 } — retry-safe: the input
//             is content-hash keyed, so a retry embeds the identical text into
//             the identical vector (unlike kg.extract's non-deterministic call)
//   server-only the user's own embedding key; no vendor offers a job-scoped
//             sub-key (the `note.generate` argument)
//   throttle  `aiProviderThrottleKey(userId)`, before the provider call
//   subject   `user` / userId, `skipDedup: true` — every batch is distinct work
//   payload   { userId, subjectKind: 'entity' | 'item', ids: uuid[] ≤ 128 }
//
// For each row: build the profile text (`profile-text.ts`), hash
// `sha256(model + '\n' + text)`, SKIP when `embedding_hash` already equals it,
// embed the rest, write `embedding` + `embedding_model` + `embedding_hash`.
// A missing key or a provider without embeddings is not a failure — the job
// returns normally with nothing to do (the `search.index` posture).
//
// ⚠ A `sensitive` PersonFact is NEVER embedded (§5.6/§15: it never leaves the
// deployment for any purpose) — and any stale vector on one is cleared.
// =============================================================================

import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job } from '@prisma/client';
import { z } from 'zod';

import { AiAuthError } from '../../ai/ai-errors';
import type { JobExecutionProfile } from '../../jobs/job-execution-profile';
import type { JobHandler } from '../../jobs/job-handler.interface';
import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { ProviderThrottleService } from '../../jobs/provider-throttle.service';
import { aiProviderThrottleKey } from '../../notes/job-types';
import { PrismaService } from '../../prisma/prisma.service';
import { KG_EMBED_JOB_TYPE } from '../job-types';
import { GraphEmbedder, vectorLiteral } from '../resolution/graph-embedder.service';
import { buildEntityProfileText, buildItemProfileText, profileHash } from '../resolution/profile-text';

export const KG_EMBED_MAX_RUNTIME_MS = 5 * 60_000;
export const KG_EMBED_MAX_ATTEMPTS = 3;
/** `provider.embedding.maxBatchSize` for this build's provider; the payload ceiling. */
export const KG_EMBED_MAX_IDS = 128;

const payloadSchema = z.object({
  userId: z.guid(),
  subjectKind: z.enum(['entity', 'item']),
  ids: z.array(z.guid()).min(1).max(KG_EMBED_MAX_IDS),
});
export type KgEmbedPayload = z.infer<typeof payloadSchema>;

export function readKgEmbedPayload(payload: unknown): KgEmbedPayload | null {
  const parsed = payloadSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

interface Profile {
  id: string;
  text: string | null; // null = must not be embedded (clear any vector)
  currentHash: string | null;
}

const LIVE = ['accepted', 'edited'] as const;

@Injectable()
export class KgEmbedHandler implements JobHandler, OnModuleInit {
  private readonly logger = new Logger(KgEmbedHandler.name);

  readonly type = KG_EMBED_JOB_TYPE;
  readonly profile: JobExecutionProfile = { maxRuntimeMs: KG_EMBED_MAX_RUNTIME_MS, maxAttempts: KG_EMBED_MAX_ATTEMPTS };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly embedder: GraphEmbedder,
    private readonly throttle: ProviderThrottleService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const payload = readKgEmbedPayload(job.payload);
    if (!payload) {
      this.logger.warn(`${KG_EMBED_JOB_TYPE} job ${job.id} carries an unreadable payload; nothing to do`);
      return;
    }
    const { userId, subjectKind } = payload;

    const embedder = await this.embedder.resolve(userId);
    if (!embedder.ok) {
      this.logger.debug(`${KG_EMBED_JOB_TYPE} job ${job.id}: embedding unavailable (${embedder.reason}); nothing to do`);
      return;
    }

    const profiles = subjectKind === 'entity'
      ? await this.entityProfiles(userId, payload.ids)
      : await this.itemProfiles(userId, payload.ids);

    // Never embed what must not leave the deployment; drop any stale vector.
    const forbidden = profiles.filter((p) => p.text === null && p.currentHash !== null).map((p) => p.id);
    if (forbidden.length > 0) {
      await this.prisma.$executeRaw`
        UPDATE kg_items SET embedding = NULL, embedding_model = NULL, embedding_hash = NULL
         WHERE id = ANY(${forbidden}::uuid[])`;
    }

    const todo = profiles
      .filter((p): p is Profile & { text: string } => p.text !== null)
      .map((p) => ({ ...p, hash: profileHash(embedder.model, p.text) }))
      .filter((p) => p.hash !== p.currentHash);
    if (todo.length === 0) {
      this.logger.log(`${KG_EMBED_JOB_TYPE} job ${job.id}: ${profiles.length} ${subjectKind}(s) unchanged; nothing to embed`);
      return;
    }

    this.throttle.registerProviderKey(this.type, aiProviderThrottleKey(userId));
    let vectors: number[][];
    try {
      vectors = await embedder.embed(todo.map((p) => p.text));
    } catch (error) {
      if (error instanceof AiAuthError) {
        this.logger.debug(`${KG_EMBED_JOB_TYPE} job ${job.id}: the owner's key was refused; nothing embedded`);
        return;
      }
      throw error;
    }

    await this.prisma.$transaction(
      todo.map((p, i) => {
        const literal = vectorLiteral(vectors[i]);
        return subjectKind === 'entity'
          ? this.prisma.$executeRaw`
              UPDATE kg_entities SET embedding = ${literal}::vector, embedding_model = ${embedder.model}, embedding_hash = ${p.hash}
               WHERE id = ${p.id}::uuid AND owner_id = ${userId}::uuid`
          : this.prisma.$executeRaw`
              UPDATE kg_items SET embedding = ${literal}::vector, embedding_model = ${embedder.model}, embedding_hash = ${p.hash}
               WHERE id = ${p.id}::uuid AND owner_id = ${userId}::uuid`;
      }),
    );
    this.logger.log(
      `${KG_EMBED_JOB_TYPE} job ${job.id}: embedded ${todo.length} of ${profiles.length} ${subjectKind}(s) model=${embedder.model}`,
    );
  }

  /** Entity profiles: aliases, organizations, roles, top co-mentions. */
  private async entityProfiles(ownerId: string, ids: string[]): Promise<Profile[]> {
    const entities = await this.prisma.kgEntity.findMany({
      where: { id: { in: ids }, ownerId, reviewStatus: { in: [...LIVE] }, mergedIntoId: null },
      select: { id: true, type: true, label: true, embeddingHash: true },
    });
    if (entities.length === 0) return [];
    const entityIds = entities.map((e) => e.id);
    const [aliases, orgEdges] = await Promise.all([
      this.prisma.kgEntityAlias.findMany({
        where: { entityId: { in: entityIds } },
        select: { entityId: true, alias: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      this.prisma.kgRelation.findMany({
        where: { ownerId, fromId: { in: entityIds }, type: { in: ['WORKS_FOR', 'HAS_ROLE'] }, reviewStatus: { in: [...LIVE] } },
        select: { fromId: true, toId: true, type: true, props: true },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
    ]);
    const orgLabels = new Map(
      (
        await this.prisma.kgEntity.findMany({
          where: { id: { in: [...new Set(orgEdges.map((e) => e.toId))] }, ownerId },
          select: { id: true, label: true },
        })
      ).map((o) => [o.id, o.label]),
    );
    const coMentions = await this.coMentions(ownerId, entityIds);

    return entities.map((e) => {
      const edges = orgEdges.filter((r) => r.fromId === e.id);
      return {
        id: e.id,
        currentHash: e.embeddingHash,
        text: buildEntityProfileText(
          { type: e.type, label: e.label, aliases: aliases.filter((a) => a.entityId === e.id).map((a) => a.alias) },
          {
            orgLabels: edges.map((r) => orgLabels.get(r.toId)).filter((l): l is string => !!l),
            roleTitles: edges
              .filter((r) => r.type === 'HAS_ROLE')
              .map((r) => (r.props as Record<string, unknown>)?.title)
              .filter((t): t is string => typeof t === 'string'),
            coMentioned: coMentions.get(e.id) ?? [],
          },
        ),
      };
    });
  }

  /** The labels most often mentioned in the same notes/transcripts, most frequent first. */
  private async coMentions(ownerId: string, entityIds: string[]): Promise<Map<string, string[]>> {
    const rows = await this.prisma.$queryRaw<Array<{ entity_id: string; label: string; n: bigint }>>`
      SELECT m.entity_id::text AS entity_id, e.label, count(*) AS n
        FROM kg_mentions m
        JOIN kg_mentions o ON o.owner_id = m.owner_id AND o.entity_id <> m.entity_id
                          AND (o.note_id = m.note_id OR o.transcript_id = m.transcript_id)
        JOIN kg_entities e ON e.id = o.entity_id AND e.review_status IN ('accepted', 'edited')
       WHERE m.owner_id = ${ownerId}::uuid AND m.entity_id = ANY(${entityIds}::uuid[])
       GROUP BY m.entity_id, e.id, e.label
       ORDER BY m.entity_id, n DESC, e.label`;
    const out = new Map<string, string[]>();
    for (const r of rows) {
      const list = out.get(r.entity_id) ?? [];
      if (list.length < 5) list.push(r.label);
      out.set(r.entity_id, list);
    }
    return out;
  }

  /** Item profiles; a sensitive PersonFact gets `text: null`. */
  private async itemProfiles(ownerId: string, ids: string[]): Promise<Profile[]> {
    const items = await this.prisma.kgItem.findMany({
      where: { id: { in: ids }, ownerId, reviewStatus: { in: [...LIVE] } },
      select: { id: true, kind: true, title: true, statement: true, sensitivity: true, subjectId: true, embeddingHash: true },
    });
    const subjects = new Map(
      (
        await this.prisma.kgEntity.findMany({
          where: { id: { in: items.map((i) => i.subjectId).filter((s): s is string => !!s) }, ownerId },
          select: { id: true, label: true },
        })
      ).map((s) => [s.id, s.label]),
    );
    return items.map((i) => ({
      id: i.id,
      currentHash: i.embeddingHash,
      text:
        i.sensitivity === 'sensitive'
          ? null
          : buildItemProfileText({
              kind: i.kind,
              title: i.title,
              statement: i.statement,
              subjectLabel: i.subjectId ? (subjects.get(i.subjectId) ?? null) : null,
            }),
    }));
  }
}
