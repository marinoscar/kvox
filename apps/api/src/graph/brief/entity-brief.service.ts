// =============================================================================
// EntityBriefService (#372, epic #347; docs/specs/ontology.md §9.1, §9.2, §9.4)
// =============================================================================
//
// "What's the latest on Acme?" — answered from STORED ROWS ONLY:
//
//   - five deterministic, cited sections (`brief-sections.ts`) over the
//     entity's readable items and exclusive relations, windowed by `since`
//     and evaluated at `as_of`;
//   - the latest digest `kg.entity_digest` wrote, shown as stored;
//   - related sources: the hybrid FTS+vector search arm fused with the graph
//     arm (`brief-related.ts`) — never the graph alone (§9.4).
//
// ⚠ NO AI MODEL IS EVER CALLED HERE. Every AI call in this repository runs in
// a queue job (CLAUDE.md "Every Long-Running Activity Is a Queue Job"; Notes
// rule 1). A stale digest is refreshed by ENQUEUEING `kg.entity_digest` —
// after a configuration-only resolver check, so a caller with no key never
// gets a job that could only return — and the response says so
// (`digestPending`, `digestUnavailable`). The one outbound call a brief can
// cause is the text arm's query embedding, which is `GET /api/search`'s
// existing posture and never a generative call.
//
// Window rules: `since` = query → the caller's last view → the digest's
// `covers_until` → 30 days before `asOf`. The view is recorded AFTER the
// response is assembled, so this visit's delta is against the previous one.
// With `as_of`: no digest, never stale, never pending, nothing enqueued and
// the view is not moved.
//
// Two callers: the controller (`enqueueStaleDigest: true`) and the Ask
// agent's read-only `entity_brief` tool (#377, `markViewed: false,
// enqueueStaleDigest: false`).
//
// ⚠ Never log a label, a statement, a quote or a snippet — ids and counts only.
// =============================================================================

import { BadRequestException, HttpException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { KgEntityDigest } from '@prisma/client';

import { AI_CONFLICT_REASONS, AiTaskModelResolver } from '../../ai/ai-task-model-resolver.service';
import type { RequestUser } from '../../auth/interfaces/authenticated-user.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { SearchService } from '../../search/search.service';
import { GRAPH_NOT_FOUND_MESSAGES, GraphAccessService } from '../access/graph-access.service';
import { KG_ENTITY_DIGEST_JOB_TYPE, KG_SUBJECT_ENTITY } from '../job-types';
import { GraphOntologyService } from '../ontology/graph-ontology.service';
import { AsOfParseError, parseAsOf } from '../read/as-of';
import { withGraphStatementTimeout } from '../read/graph-query-timeout';
import {
  briefItems,
  entityRefs,
  evidenceIdsFor,
  graphDocCandidates,
  isDigestStale,
  newestChange,
  oneHopPersonIds,
  ownedEvidenceIds,
  peopleChangeRelations,
  visibleDocs,
  workerIds,
} from './brief-queries';
import { fuseRelatedSources, relatedKey, type GraphArmHit, type RelatedDoc, type TextArmHit } from './brief-related';
import { buildBriefSections, exclusiveRelationTypes } from './brief-sections';
import {
  BRIEF_ENTRY_EVIDENCE_IDS,
  DIGEST_UNAVAILABLE_REASONS,
  type DigestUnavailableReason,
  type EntityBriefResponse,
} from './dto/entity-brief.dto';
import { readDigestStatements } from './citation-validation';
import { EntityDigestEnqueuer } from './entity-digest.enqueuer';
import { EntityViewService } from './entity-view.service';

/** Without `since`, a view or a digest: this many days before `asOf`. */
export const BRIEF_DEFAULT_WINDOW_DAYS = 30;
/** A digest job that failed this recently is not re-enqueued (a failing provider is not re-billed per view). */
export const DIGEST_FAILURE_BACKOFF_MS = 15 * 60 * 1000;
/** Results the text arm asks `SearchService` for. */
export const BRIEF_TEXT_ARM_LIMIT = 20;
/** Documents the graph arm contributes to the fusion. */
export const BRIEF_GRAPH_ARM_LIMIT = 20;
/** `SearchService`'s own `q` ceiling. */
const SEARCH_QUERY_MAX = 256;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface EntityBriefOptions {
  /** Raw `since` (`YYYY-MM-DD` or ISO datetime with offset). */
  since?: string;
  /** Raw `as_of`. */
  asOf?: string;
  markViewed: boolean;
  enqueueStaleDigest: boolean;
}

/** The caller: an id, plus the permission list `SearchService` narrows on. */
export type BriefReader = Pick<RequestUser, 'id' | 'permissions'> & Partial<RequestUser>;

function parseInstantOr400(raw: string | undefined, now: Date): Date | null {
  if (raw === undefined || raw === '') return null;
  try {
    return parseAsOf(raw, now);
  } catch (err) {
    if (err instanceof AsOfParseError) throw new BadRequestException(err.message);
    throw err;
  }
}

@Injectable()
export class EntityBriefService {
  private readonly logger = new Logger(EntityBriefService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: GraphAccessService,
    private readonly ontology: GraphOntologyService,
    private readonly views: EntityViewService,
    private readonly search: SearchService,
    private readonly resolver: AiTaskModelResolver,
    private readonly enqueuer: EntityDigestEnqueuer,
  ) {}

  async getBrief(user: BriefReader, entityId: string, opts: EntityBriefOptions): Promise<EntityBriefResponse> {
    const ownerId = user.id;
    const entity = await this.access.require(ownerId, 'entity', entityId, 'view');
    if (entity.mergedIntoId !== null) throw new NotFoundException(GRAPH_NOT_FOUND_MESSAGES.entity);

    const now = new Date();
    const asOfSet = opts.asOf !== undefined && opts.asOf !== '';
    const asOf = parseInstantOr400(opts.asOf, now) ?? now;
    const querySince = parseInstantOr400(opts.since, now);

    const [schema, lastViewedAt, digestRow] = await Promise.all([
      this.ontology.effectiveSchemaFor(ownerId),
      this.views.lastViewedAt(ownerId, entityId),
      this.prisma.kgEntityDigest.findFirst({ where: { entityId, ownerId } }),
    ]);
    const exclusiveTypes = exclusiveRelationTypes(schema.relationTypes);
    const exclusiveList = [...exclusiveTypes];

    // -- The window ----------------------------------------------------------
    let since: Date;
    let sinceSource: EntityBriefResponse['window']['sinceSource'];
    if (querySince) {
      since = querySince;
      sinceSource = 'query';
    } else if (lastViewedAt) {
      since = lastViewedAt;
      sinceSource = 'last_viewed';
    } else if (digestRow) {
      since = digestRow.coversUntil;
      sinceSource = 'digest';
    } else {
      since = new Date(asOf.getTime() - BRIEF_DEFAULT_WINDOW_DAYS * DAY_MS);
      sinceSource = 'default';
    }

    // -- Deterministic sections (bounded, one transaction, 3 s budget) --------
    const { sections, change } = await withGraphStatementTimeout(
      this.prisma,
      this.logger,
      { ownerId, route: 'brief' },
      async (tx) => {
        const workers = entity.type === 'Person' ? new Set<string>() : await workerIds(tx, ownerId, entityId, asOf);
        const persons = await oneHopPersonIds(tx, ownerId, entityId, asOf);
        const [items, relations, staleness] = await Promise.all([
          briefItems(tx, ownerId, entityId, workers, asOf),
          peopleChangeRelations(tx, ownerId, [entityId, ...persons], exclusiveList, since, asOf),
          asOfSet ? Promise.resolve(null) : newestChange(tx, ownerId, entityId, exclusiveList, now),
        ]);
        const evidence = await evidenceIdsFor(
          tx,
          ownerId,
          { item: items.map((i) => i.id), relation: relations.map((r) => r.id) },
          BRIEF_ENTRY_EVIDENCE_IDS,
        );
        for (const i of items) i.evidenceIds = evidence.get(`item:${i.id}`) ?? [];
        for (const r of relations) r.evidenceIds = evidence.get(`relation:${r.id}`) ?? [];

        const refIds = new Set<string>();
        for (const i of items) {
          if (i.ownerPersonId) refIds.add(i.ownerPersonId);
          if (i.counterpartyId) refIds.add(i.counterpartyId);
        }
        for (const r of relations) {
          refIds.add(r.fromId);
          refIds.add(r.toId);
        }
        const entities = await entityRefs(tx, ownerId, [...refIds]);

        return {
          sections: buildBriefSections({
            entity: { id: entityId, type: entity.type },
            since,
            asOf,
            items,
            relations,
            exclusiveTypes,
            workerIds: workers,
            entities,
          }),
          change: staleness,
        };
      },
    );

    // -- The digest, staleness, and the guarded enqueue -----------------------
    let digest: EntityBriefResponse['digest'] = null;
    let digestStale = false;
    let digestPending = false;
    let digestUnavailable: DigestUnavailableReason | null = null;

    if (!asOfSet) {
      digest = digestRow ? await this.presentDigest(ownerId, digestRow) : null;
      digestStale = change !== null && isDigestStale(digestRow, change);
      if (digestStale) {
        digestPending = await this.digestJobActive(entityId);
        if (!digestPending && opts.enqueueStaleDigest) {
          const refresh = await this.refreshDigest(ownerId, entityId, now);
          digestPending = refresh.pending;
          digestUnavailable = refresh.unavailable;
        }
      }
    }

    // -- Related sources (never graph-only, §9.4) -----------------------------
    const related = await this.relatedSources(user, entityId, entity.label, now);

    const response: EntityBriefResponse = {
      entity: { id: entity.id, label: entity.label, type: entity.type },
      window: {
        since: since.toISOString(),
        sinceSource,
        asOf: asOf.toISOString(),
        lastViewedAt: lastViewedAt ? lastViewedAt.toISOString() : null,
      },
      digest,
      digestStale,
      digestPending,
      digestUnavailable,
      sections,
      related,
    };

    // AFTER assembling: this visit's delta was computed against the previous one.
    if (opts.markViewed && !asOfSet) {
      await this.views.markViewed(ownerId, entityId, new Date());
    }

    this.logger.debug({
      msg: 'entity brief assembled',
      entityId,
      sinceSource,
      asOf: asOfSet,
      whatChanged: sections.whatChanged.length,
      peopleChanges: sections.peopleChanges.length,
      related: related.length,
      digestStale,
      digestPending,
    });
    return response;
  }

  /** The stored digest, keeping only statements whose evidence the caller still owns. */
  private async presentDigest(ownerId: string, row: KgEntityDigest): Promise<EntityBriefResponse['digest']> {
    const statements = readDigestStatements(row.citations);
    const owned = await ownedEvidenceIds(this.prisma, ownerId, statements.flatMap((s) => s.evidenceIds));
    const kept = statements
      .map((s) => ({ text: s.text, evidenceIds: s.evidenceIds.filter((id) => owned.has(id)) }))
      .filter((s) => s.evidenceIds.length > 0);
    return {
      statements: kept,
      coversUntil: row.coversUntil.toISOString(),
      generatedAt: row.generatedAt.toISOString(),
      model: row.model,
    };
  }

  /** A `kg.entity_digest` job for this entity is pending or running. */
  private async digestJobActive(entityId: string): Promise<boolean> {
    const job = await this.prisma.job.findFirst({
      where: {
        type: KG_ENTITY_DIGEST_JOB_TYPE,
        subjectType: KG_SUBJECT_ENTITY,
        subjectId: entityId,
        status: { in: ['pending', 'running'] },
      },
      select: { id: true },
    });
    return job !== null;
  }

  /**
   * Stale, nothing pending, and the caller asked for a refresh:
   *   1. the resolver — configuration and key presence only, no provider
   *      call; a 409-class outcome is reported and nothing is enqueued;
   *   2. a failure less than 15 minutes ago → nothing is enqueued;
   *   3. otherwise one deduplicated `kg.entity_digest` job.
   */
  private async refreshDigest(
    ownerId: string,
    entityId: string,
    now: Date,
  ): Promise<{ pending: boolean; unavailable: DigestUnavailableReason | null }> {
    try {
      await this.resolver.resolve(ownerId, 'graph.digest');
    } catch (err) {
      const reason = conflictReason(err);
      if (reason) return { pending: false, unavailable: reason };
      // Anything else (a 400, an unexpected failure) must not break the brief.
      this.logger.warn({ msg: 'digest model resolution failed; not enqueueing', entityId, error: errorName(err) });
      return { pending: false, unavailable: null };
    }

    const latest = await this.prisma.job.findFirst({
      where: { type: KG_ENTITY_DIGEST_JOB_TYPE, subjectType: KG_SUBJECT_ENTITY, subjectId: entityId },
      orderBy: { createdAt: 'desc' },
      select: { status: true, finishedAt: true, createdAt: true },
    });
    if (latest?.status === 'failed') {
      const at = (latest.finishedAt ?? latest.createdAt).getTime();
      if (now.getTime() - at < DIGEST_FAILURE_BACKOFF_MS) return { pending: false, unavailable: null };
    }

    try {
      const job = await this.enqueuer.enqueue(ownerId, entityId);
      return { pending: job !== null, unavailable: null };
    } catch (err) {
      this.logger.warn({ msg: 'digest enqueue failed', entityId, error: errorName(err) });
      return { pending: false, unavailable: null };
    }
  }

  /**
   * Hybrid retrieval: the text arm (`SearchService`, itself FTS+vector fused)
   * and the graph arm (documents the entity's graph cites), fused by RRF then
   * weighted by recency and confidence. A search failure degrades to the graph
   * arm — the brief always renders — and is logged by reason, not content.
   */
  private async relatedSources(user: BriefReader, entityId: string, label: string, now: Date) {
    const ownerId = user.id;
    const textHits: TextArmHit[] = [];
    const q = label.trim().slice(0, SEARCH_QUERY_MAX);
    if (q.length > 0) {
      try {
        const res = await this.search.search(
          { q, types: 'transcript,note', limit: BRIEF_TEXT_ARM_LIMIT },
          user as RequestUser,
        );
        for (const r of res.results) {
          const snippet = r.snippets[0];
          textHits.push({
            kind: r.type,
            id: r.id,
            title: r.title,
            snippetHtml: snippet?.html ?? null,
            startMs: snippet?.startMs ?? null,
          });
        }
      } catch (err) {
        // A 403 (neither transcripts:read nor notes:read) or a 400 is a partial
        // brief, not a failed one.
        this.logger.warn({ msg: 'brief text arm unavailable', entityId, error: errorName(err) });
      }
    }

    const candidates = await graphDocCandidates(this.prisma, ownerId, entityId);
    const ids = (kind: 'transcript' | 'note') => [
      ...new Set([
        ...candidates.filter((c) => c.kind === kind).map((c) => c.id),
        ...textHits.filter((h) => h.kind === kind).map((h) => h.id),
      ]),
    ];
    const visible = await visibleDocs(this.prisma, ownerId, ids('transcript'), ids('note'));
    const docs = new Map<string, RelatedDoc>(
      visible.map((d) => [relatedKey(d.kind, d.id), { title: d.title, occurredAt: d.occurredAt }]),
    );

    const graphHits: GraphArmHit[] = candidates
      .filter((c) => docs.has(relatedKey(c.kind, c.id)))
      .sort((a, b) => {
        const at = docs.get(relatedKey(a.kind, a.id))!.occurredAt?.getTime() ?? -Infinity;
        const bt = docs.get(relatedKey(b.kind, b.id))!.occurredAt?.getTime() ?? -Infinity;
        return bt - at || (a.id < b.id ? -1 : 1);
      })
      .slice(0, BRIEF_GRAPH_ARM_LIMIT);

    return fuseRelatedSources({ text: textHits, graph: graphHits, docs, now });
  }
}

/** The resolver's 409 `details.reason`, when it is one the brief reports. */
export function conflictReason(err: unknown): DigestUnavailableReason | null {
  if (!(err instanceof HttpException) || err.getStatus() !== 409) return null;
  const body = err.getResponse() as { details?: { reason?: unknown } } | string;
  const reason = typeof body === 'object' ? body.details?.reason : undefined;
  return (DIGEST_UNAVAILABLE_REASONS as readonly unknown[]).includes(reason)
    ? (reason as DigestUnavailableReason)
    : null;
}

function errorName(err: unknown): string {
  if (err instanceof HttpException) return `${err.name}:${err.getStatus()}`;
  return err instanceof Error ? err.name : typeof err;
}

// Kept referenced so the four resolver reasons and the DTO's enum cannot drift.
const _reasonParity: readonly DigestUnavailableReason[] = Object.values(AI_CONFLICT_REASONS);
void _reasonParity;
