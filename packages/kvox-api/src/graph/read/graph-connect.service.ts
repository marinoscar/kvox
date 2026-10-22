// =============================================================================
// GraphConnectService (GIC-14, #675; docs/specs/ontology.md §12, §22)
// =============================================================================
//
// "What connects these notes?" — given two or more notes, transcripts or
// entities, the entities they SHARE and the paths that BRIDGE them.
//
//   - a note or transcript is resolved to the entities it touches through its
//     readable `kg_mentions` (`linked` / `new`) of readable entities. A
//     `sensitive` PersonFact is an item, never an entity, so none can enter;
//   - an entity input touches itself and its readable one-hop neighbours, so
//     two entities "share" the people and projects both are related to;
//   - a single note or transcript on its own answers "what this note touches" (no `shared`, no paths);
//   - an entity is SHARED when two or more inputs touch it; ranked by how many
//     inputs (coverage), then by mention count;
//   - bridges reuse `GraphPathsService` (k = 1 per pair of inputs, between each
//     input's strongest entity that is not already shared), inside one 3 s
//     budget shared by every pair; a pair that runs out of time only sets
//     `truncated`;
//   - an input the caller cannot read (not theirs, deleted, a share they lost,
//     an unreadable entity) is one 404 that names none of them.
//
// ⚠ Never log a title, label or quote — ids and counts only.
// =============================================================================

import { Inject, Injectable, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common';

import { Prisma } from '../../core/index.js';
import { KVOX_PRISMA } from '../../ports/index.js';
import { SEARCH_TRANSCRIPT_VISIBILITY, type SearchTranscriptVisibility } from '../../search/index.js';
import type { KvoxGraphDb } from '../data/graph-db.js';
import {
  GRAPH_NODE_CAP,
  type GraphConnectPath,
  type GraphConnectRequest,
  type GraphConnectResponse,
  type GraphEdge,
  type GraphNode,
  type GraphSlice,
} from './dto/graph-read.dto.js';
import { relationValidAtSql } from './as-of.js';
import { GraphNeighborhoodService } from './graph-neighborhood.service.js';
import { GraphPathsService } from './graph-paths.service.js';
import { GRAPH_STATEMENT_TIMEOUT_MS, GRAPH_QUERY_TIMEOUT_REASON } from './graph-query-timeout.js';
import { asOfOr400 } from './read-params.js';
import { asOfRelationSql, readableEntitySql, readableMentionSql, uuidArray } from './read-sql.js';

/** The entities each input lists in the response (the strongest first); `shared` still counts all of them. */
export const CONNECT_INPUT_ENTITY_CAP = 50;
/** The most shared entities returned. */
export const CONNECT_SHARED_CAP = 100;
/** The most pairs of inputs a bridge is searched for. */
export const CONNECT_PAIR_CAP = 6;
/** The most bridge paths returned. */
export const CONNECT_PATH_CAP = 6;
/** The most shared entities (plus entity inputs) the slice is seeded with. */
export const CONNECT_SLICE_SEEDS = 20;
/** The node cap of the slice's neighbourhood part. */
export const CONNECT_SLICE_CAP = 60;

/** A message shared by every unreadable input, so none can be told from another. */
export const CONNECT_NOT_FOUND_MESSAGE = 'One of those notes, transcripts or entities was not found';

type InputKind = 'note' | 'transcript' | 'entity';

interface Input {
  kind: InputKind;
  id: string;
  title: string;
  /** Mentions (or relations) of each entity id from this input. */
  counts: Map<string, number>;
}

interface TitleRow {
  id: string;
  title: string | null;
}

interface CountRow {
  input_id: string;
  entity_id: string;
  n: number;
}

/**
 * GraphConnectService: wiring the slice registers itself; a host configures it through the slice module's `forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphConnectService {
  private readonly logger = new Logger(GraphConnectService.name);

  constructor(
    @Inject(KVOX_PRISMA) private readonly prisma: KvoxGraphDb,
    private readonly neighborhood: GraphNeighborhoodService,
    private readonly pathFinder: GraphPathsService,
    @Inject(SEARCH_TRANSCRIPT_VISIBILITY) private readonly visibility: SearchTranscriptVisibility,
  ) {}

  /** The shared entities and bridges of the caller's own notes, transcripts and entities. */
  async connect(user: { id: string }, body: GraphConnectRequest): Promise<GraphConnectResponse> {
    const started = Date.now();
    const ownerId = user.id;
    const asOf = asOfOr400(body.as_of);
    const noteIds = [...new Set(body.noteIds ?? [])];
    const transcriptIds = [...new Set(body.transcriptIds ?? [])];
    const entityIds = [...new Set(body.entityIds ?? [])];

    const inputs = await this.loadInputs(ownerId, noteIds, transcriptIds, entityIds);
    await this.loadTouched(ownerId, inputs, asOf);

    // ---- shared entities -----------------------------------------------------
    const byEntity = new Map<string, { inputIds: string[]; mentionCount: number }>();
    for (const input of inputs) {
      for (const [entityId, n] of input.counts) {
        const cur = byEntity.get(entityId) ?? { inputIds: [], mentionCount: 0 };
        cur.inputIds.push(input.id);
        cur.mentionCount += n;
        byEntity.set(entityId, cur);
      }
    }
    const allShared = [...byEntity.entries()]
      .filter(([, v]) => v.inputIds.length >= 2)
      .map(([entityId, v]) => ({ entityId, inputIds: v.inputIds, mentionCount: v.mentionCount }))
      .sort(
        (a, b) =>
          b.inputIds.length - a.inputIds.length ||
          b.mentionCount - a.mentionCount ||
          (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0),
      );
    let truncated = allShared.length > CONNECT_SHARED_CAP;
    const shared = allShared.slice(0, CONNECT_SHARED_CAP);
    const sharedIds = new Set(allShared.map((s) => s.entityId));

    // ---- bridges ---------------------------------------------------------------
    const bridge = await this.bridges(user, inputs, sharedIds, body.maxHops, body.as_of, started);
    truncated = truncated || bridge.truncated;

    // ---- the slice: shared entities with their edges, plus the bridges ------------
    // A lone note or transcript has nothing to share: its own strongest entities seed the slice.
    const seeds = [
      ...new Set([
        ...inputs.filter((i) => i.kind === 'entity').map((i) => i.id),
        ...shared.map((s) => s.entityId),
        ...(inputs.length === 1 ? rankedEntities(inputs[0]) : []),
      ]),
    ].slice(0, CONNECT_SLICE_SEEDS);
    const walked =
      seeds.length > 0
        ? await this.neighborhood.walk(ownerId, seeds, { hops: 1, asOf, cap: CONNECT_SLICE_CAP })
        : null;
    const slice = mergeSlices(asOf, seeds, walked, bridge.slices);

    this.logger.debug({
      msg: 'graph connect',
      ownerId,
      inputs: inputs.length,
      shared: allShared.length,
      paths: bridge.paths.length,
      ms: Date.now() - started,
    });
    return {
      inputs: inputs.map((i) => ({
        kind: i.kind,
        id: i.id,
        title: i.title,
        entityIds: rankedEntities(i).slice(0, CONNECT_INPUT_ENTITY_CAP),
      })),
      shared,
      paths: bridge.paths,
      slice,
      truncated: truncated || slice.truncated,
    };
  }

  // ---------------------------------------------------------------------------

  /** Every input as a readable row; one that is not is the same 404 as all of them. */
  private async loadInputs(
    ownerId: string,
    noteIds: string[],
    transcriptIds: string[],
    entityIds: string[],
  ): Promise<Input[]> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    const notes = noteIds.length
      ? await this.prisma.$queryRaw<TitleRow[]>`
          SELECT n.id::text AS id, n.title FROM notes n
          WHERE n.id = ANY(${uuidArray(noteIds)}) AND n.owner_id = ${owner} AND n.deleted_at IS NULL`
      : [];
    let transcripts: TitleRow[] = [];
    if (transcriptIds.length) {
      const viewer = await this.visibility.viewerFor(ownerId);
      transcripts = await this.visibility.run(viewer, (tx) => tx.$queryRaw<TitleRow[]>`
        SELECT t.id::text AS id, t.title FROM transcripts t
        WHERE t.id = ANY(${uuidArray(transcriptIds)}) AND ${this.visibility.transcriptVisibleSql(viewer, 't')}`);
    }
    const entities = entityIds.length
      ? await this.prisma.$queryRaw<{ id: string; label: string }[]>`
          SELECT e.id::text AS id, e.label FROM kg_entities e
          WHERE e.owner_id = ${owner} AND e.id = ANY(${uuidArray(entityIds)}) AND ${readableEntitySql('e')}`
      : [];
    if (notes.length !== noteIds.length || transcripts.length !== transcriptIds.length || entities.length !== entityIds.length) {
      throw new NotFoundException(CONNECT_NOT_FOUND_MESSAGE);
    }
    const make = (kind: InputKind, rows: TitleRow[]): Input[] =>
      rows.map((r) => ({ kind, id: r.id, title: r.title ?? '', counts: new Map<string, number>() }));
    return [
      ...make('note', notes),
      ...make('transcript', transcripts),
      ...entities.map<Input>((e) => ({ kind: 'entity', id: e.id, title: e.label, counts: new Map() })),
    ];
  }

  /** Fills each input's `counts`: documents through readable mentions, entities through themselves and their neighbours. */
  private async loadTouched(ownerId: string, inputs: Input[], asOf: Date): Promise<void> {
    const owner = Prisma.sql`${ownerId}::uuid`;
    const noteIds = inputs.filter((i) => i.kind === 'note').map((i) => i.id);
    const transcriptIds = inputs.filter((i) => i.kind === 'transcript').map((i) => i.id);
    const entityIds = inputs.filter((i) => i.kind === 'entity').map((i) => i.id);
    const byId = new Map(inputs.map((i) => [i.id, i]));
    const add = (rows: CountRow[]): void => {
      for (const r of rows) {
        const input = byId.get(r.input_id);
        if (input) input.counts.set(r.entity_id, (input.counts.get(r.entity_id) ?? 0) + Number(r.n));
      }
    };

    try {
      if (noteIds.length || transcriptIds.length) {
        add(
          await this.prisma.$transaction(async (tx) => {
            await tx.$executeRaw(Prisma.raw(`SET LOCAL statement_timeout = '${GRAPH_STATEMENT_TIMEOUT_MS}ms'`));
            return tx.$queryRaw<CountRow[]>`
              SELECT coalesce(m.note_id, m.transcript_id)::text AS input_id, m.entity_id::text AS entity_id, count(*)::int AS n
              FROM kg_mentions m
              JOIN kg_entities e ON e.id = m.entity_id AND e.owner_id = ${owner} AND ${readableEntitySql('e')}
              WHERE m.owner_id = ${owner} AND ${readableMentionSql('m')}
                AND (m.note_id = ANY(${uuidArray(noteIds)}) OR m.transcript_id = ANY(${uuidArray(transcriptIds)}))
              GROUP BY 1, 2`;
          }),
        );
      }
      if (entityIds.length) {
        for (const id of entityIds) byId.get(id)?.counts.set(id, 1);
        add(
          await this.prisma.$queryRaw<CountRow[]>`
            SELECT x.input_id, x.entity_id, count(*)::int AS n FROM (
              SELECT r.from_id::text AS input_id, r.to_id::text AS entity_id
              FROM kg_relations r
              JOIN kg_entities o ON o.id = r.to_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
              WHERE r.owner_id = ${owner} AND r.from_id = ANY(${uuidArray(entityIds)}) AND ${asOfRelationSql('r')}
                AND ${relationValidAtSql('r', asOf)}
              UNION ALL
              SELECT r.to_id::text, r.from_id::text
              FROM kg_relations r
              JOIN kg_entities o ON o.id = r.from_id AND o.owner_id = ${owner} AND ${readableEntitySql('o')}
              WHERE r.owner_id = ${owner} AND r.to_id = ANY(${uuidArray(entityIds)}) AND r.from_id IS NOT NULL
                AND ${asOfRelationSql('r')} AND ${relationValidAtSql('r', asOf)}
            ) x GROUP BY 1, 2`,
        );
      }
    } catch (err) {
      if (isTimeout(err)) {
        this.logger.warn({ msg: 'graph connect timed out', ownerId, inputs: inputs.length });
        throw new ServiceUnavailableException({
          message: 'This part of your graph took too long to read. Try fewer notes.',
          details: { reason: GRAPH_QUERY_TIMEOUT_REASON },
        });
      }
      throw err;
    }
  }

  /** The top path between each of up to {@link CONNECT_PAIR_CAP} pairs of inputs, inside what is left of the 3 s budget. */
  private async bridges(
    user: { id: string },
    inputs: Input[],
    sharedIds: ReadonlySet<string>,
    maxHops: number,
    asOfRaw: string | undefined,
    started: number,
  ): Promise<{ paths: GraphConnectPath[]; slices: GraphSlice[]; truncated: boolean }> {
    const rep = new Map<string, string>();
    for (const input of inputs) {
      const pick = input.kind === 'entity' ? input.id : rankedEntities(input).find((id) => !sharedIds.has(id));
      if (pick) rep.set(input.id, pick);
    }
    const pairs: [Input, Input][] = [];
    for (let i = 0; i < inputs.length; i++) {
      for (let j = i + 1; j < inputs.length; j++) pairs.push([inputs[i], inputs[j]]);
    }
    const out: GraphConnectPath[] = [];
    const slices: GraphSlice[] = [];
    let truncated = pairs.length > CONNECT_PAIR_CAP;
    for (const [a, b] of pairs.slice(0, CONNECT_PAIR_CAP)) {
      const from = rep.get(a.id);
      const to = rep.get(b.id);
      if (!from || !to || from === to) continue;
      const remaining = GRAPH_STATEMENT_TIMEOUT_MS - (Date.now() - started);
      if (remaining < 300) {
        truncated = true;
        break;
      }
      try {
        const res = await this.pathFinder.paths(
          user,
          { from, to, k: 1, maxHops, as_of: asOfRaw, types: undefined, relationTypes: undefined },
          { timeoutMs: remaining },
        );
        truncated = truncated || res.truncated;
        const top = res.paths[0];
        if (!top) continue;
        out.push({ fromInput: a.id, toInput: b.id, nodeIds: top.nodeIds, edgeIds: top.edgeIds, score: top.score });
        slices.push(res.slice);
      } catch (err) {
        if (err instanceof ServiceUnavailableException) {
          truncated = true;
          break;
        }
        throw err;
      }
    }
    out.sort((x, y) => y.score - x.score);
    return { paths: out.slice(0, CONNECT_PATH_CAP), slices, truncated };
  }
}

/** An input's entities, the most mentioned first (ties by id so the order is stable). */
function rankedEntities(input: Input): string[] {
  return [...input.counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([id]) => id);
}

function isTimeout(err: unknown): boolean {
  const text = err instanceof Error ? `${err.message} ${String((err as { code?: unknown }).code ?? '')}` : String(err);
  return /57014|statement timeout|canceling statement/i.test(text);
}

/** The union of the neighbourhood of the shared entities and the bridges' slices (nodes and edges by id). */
function mergeSlices(asOf: Date, seeds: string[], walked: GraphSlice | null, bridges: GraphSlice[]): GraphSlice {
  const nodes = new Map<string, GraphNode>();
  const edges = new Map<string, GraphEdge>();
  let truncated = false;
  for (const s of [...(walked ? [walked] : []), ...bridges]) {
    for (const n of s.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    for (const e of s.edges) if (!edges.has(e.id)) edges.set(e.id, e);
    truncated = truncated || s.truncated;
  }
  return {
    seedIds: seeds,
    asOf: asOf.toISOString(),
    nodes: [...nodes.values()],
    edges: [...edges.values()],
    truncated,
    cap: GRAPH_NODE_CAP,
  };
}
