// =============================================================================
// In-memory proposal rows for the #365 stage unit tests
// =============================================================================
//
// Just enough of `PrismaService` for the three dedup stages: the proposal's
// own `kg_proposal_items` rows and their `proposal_item` evidence. Earlier
// COMMITTED proposals (rejection memory) are supplied separately, as the rows
// the two rejection queries would return.
// =============================================================================

import { randomUUID } from 'node:crypto';

import type { ProposalStageContext } from '../../src/graph/extraction/proposal-stage';
import { GRAPH_PREFERENCE_DEFAULTS, type GraphPreferences } from '../../src/graph/preferences/graph-preferences.defaults';

export const OWNER = '11111111-1111-4111-8111-111111111111';
export const PROPOSAL = '22222222-2222-4222-8222-222222222222';
export const NOTE = '33333333-3333-4333-8333-333333333333';

export interface FakeRow {
  id: string;
  proposalId: string;
  kind: 'entity' | 'relation' | 'item' | 'closing';
  payload: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  flags: string[];
  decision: string;
  origin: string;
  sortOrder: number;
}

export interface FakeEvidence {
  id: string;
  ownerId: string;
  subjectKind: string;
  subjectId: string;
  quote: string;
  transcriptId: string | null;
  segmentId: string | null;
  createdAt: Date;
}

export interface PastRow {
  proposalId: string;
  kind: 'entity' | 'relation' | 'item';
  payload: Record<string, unknown>;
  resolution: Record<string, unknown> | null;
  committedRefId: string | null;
  mergeIntoId: string | null;
}

function inList(value: unknown, filter: unknown): boolean {
  if (filter && typeof filter === 'object' && 'in' in (filter as object)) {
    return ((filter as { in: unknown[] }).in ?? []).includes(value);
  }
  return filter === undefined || value === filter;
}

export class FakeProposalDb {
  rows: FakeRow[] = [];
  evidence: FakeEvidence[] = [];
  /** What the rejected-person-fact query answers. */
  rejectedPersonFactHashes: string[] = [];
  /** What the same-note rejected-rows query answers. */
  pastRows: PastRow[] = [];
  private order = 0;

  add(kind: FakeRow['kind'], payload: Record<string, unknown>, extra: Partial<FakeRow> = {}): FakeRow {
    const row: FakeRow = {
      id: randomUUID(),
      proposalId: PROPOSAL,
      kind,
      payload,
      resolution: null,
      flags: [],
      decision: 'pending',
      origin: 'ai',
      sortOrder: this.order++,
      ...extra,
    };
    this.rows.push(row);
    return row;
  }

  cite(row: FakeRow, quote: string): void {
    this.evidence.push({
      id: randomUUID(),
      ownerId: OWNER,
      subjectKind: 'proposal_item',
      subjectId: row.id,
      quote,
      transcriptId: null,
      segmentId: null,
      createdAt: new Date(this.evidence.length * 1000),
    });
  }

  byRef(ref: string): FakeRow {
    const row = this.rows.find((r) => r.payload.ref === ref);
    if (!row) throw new Error(`no row ${ref}`);
    return row;
  }

  closings(): FakeRow[] {
    return this.rows.filter((r) => r.kind === 'closing');
  }

  readonly kgProposalItem = {
    findMany: jest.fn(async (args: { where: Record<string, unknown> }) => {
      const w = args.where;
      if (w.proposal) return this.pastRows;
      return this.rows
        .filter((r) => inList(r.proposalId, w.proposalId) && inList(r.kind, w.kind) && inList(r.origin, w.origin))
        .sort((a, b) => a.sortOrder - b.sortOrder)
        .map((r) => ({ ...r, flags: [...r.flags] }));
    }),
    update: jest.fn(async (args: { where: { id: string }; data: Partial<FakeRow> }) => {
      const row = this.rows.find((r) => r.id === args.where.id)!;
      Object.assign(row, args.data);
      return row;
    }),
    create: jest.fn(async (args: { data: Omit<FakeRow, 'id' | 'resolution'> }) => {
      const row: FakeRow = { id: randomUUID(), resolution: null, ...args.data };
      this.rows.push(row);
      return { id: row.id };
    }),
    deleteMany: jest.fn(async (args: { where: { id?: unknown; proposalId?: string } }) => {
      const before = this.rows.length;
      this.rows = this.rows.filter((r) => !(inList(r.id, args.where.id) && inList(r.proposalId, args.where.proposalId)));
      return { count: before - this.rows.length };
    }),
  };

  readonly kgEvidence = {
    findMany: jest.fn(async (args: { where: { subjectKind: string; subjectId: unknown } }) =>
      this.evidence
        .filter((e) => e.subjectKind === args.where.subjectKind && inList(e.subjectId, args.where.subjectId))
        .map((e) => ({ ...e })),
    ),
    createMany: jest.fn(async (args: { data: Array<Omit<FakeEvidence, 'id' | 'createdAt'>> }) => {
      for (const d of args.data) this.evidence.push({ id: randomUUID(), createdAt: new Date(), ...d } as FakeEvidence);
      return { count: args.data.length };
    }),
    deleteMany: jest.fn(async (args: { where: { subjectKind: string; subjectId: unknown } }) => {
      this.evidence = this.evidence.filter(
        (e) => !(e.subjectKind === args.where.subjectKind && inList(e.subjectId, args.where.subjectId)),
      );
      return { count: 0 };
    }),
  };

  readonly $queryRaw = jest.fn(async () => this.rejectedPersonFactHashes.map((hash) => ({ hash })));

  ctx(preferences: Partial<GraphPreferences['resolution']> = {}): ProposalStageContext {
    return {
      proposalId: PROPOSAL,
      userId: OWNER,
      noteId: NOTE,
      preferences: { ...GRAPH_PREFERENCE_DEFAULTS, resolution: { ...GRAPH_PREFERENCE_DEFAULTS.resolution, ...preferences } },
      ai: null,
      prisma: this as never,
      stats: {},
    };
  }
}

/** A proposal entity row linked to an existing entity (or new, with `null`). */
export function entityPayload(ref: string, type: string, label: string): Record<string, unknown> {
  return { ref, type, label, aliases: [], props: {}, occurredAt: null };
}

export function linked(entityId: string | null): Record<string, unknown> {
  return { ref: entityId, score: entityId ? 1 : null, source: entityId ? 'alias' : null, candidates: [], adjudication: null };
}
