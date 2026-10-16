// =============================================================================
// Reading a proposal's rows for the #365 stages
// =============================================================================
//
// One read of `kg_proposal_items` for a proposal, split by kind, plus the
// `ref → entity view` map every endpoint lookup goes through. Payloads were
// validated by #363's writer; they are cast, not re-parsed.
// =============================================================================

import type { Prisma } from '@prisma/client';

import type { PrismaService } from '../../prisma/prisma.service';
import type {
  EntityPayload,
  ItemPayload,
  ProposalResolution,
  RelationPayload,
} from '../proposals/proposal-payload.schema';
import { entityView, type ProposalEntityView } from './dedup-core';

export interface ProposalRow<P> {
  id: string;
  payload: P;
  flags: string[];
  decision: string;
  sortOrder: number;
}

export interface ProposalRows {
  entities: Map<string, ProposalEntityView>;
  relations: ProposalRow<RelationPayload>[];
  items: ProposalRow<ItemPayload>[];
  maxSortOrder: number;
}

type Db = Pick<PrismaService, 'kgProposalItem'>;

export async function loadProposalRows(prisma: Db, proposalId: string): Promise<ProposalRows> {
  const rows = await prisma.kgProposalItem.findMany({
    where: { proposalId },
    orderBy: { sortOrder: 'asc' },
    select: { id: true, kind: true, payload: true, resolution: true, flags: true, decision: true, sortOrder: true },
  });
  const out: ProposalRows = { entities: new Map(), relations: [], items: [], maxSortOrder: -1 };
  for (const row of rows) {
    out.maxSortOrder = Math.max(out.maxSortOrder, row.sortOrder);
    const base = { id: row.id, flags: [...row.flags], decision: row.decision, sortOrder: row.sortOrder };
    if (row.kind === 'entity') {
      const payload = row.payload as unknown as EntityPayload;
      out.entities.set(payload.ref, entityView(payload, (row.resolution ?? null) as ProposalResolution | null));
    } else if (row.kind === 'relation') {
      out.relations.push({ ...base, payload: row.payload as unknown as RelationPayload });
    } else if (row.kind === 'item') {
      out.items.push({ ...base, payload: row.payload as unknown as ItemPayload });
    }
  }
  return out;
}

export function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}
