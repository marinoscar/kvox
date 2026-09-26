// =============================================================================
// Small owner-scoped reads shared by the Ask tools (#377)
// =============================================================================
//
// Every statement here carries `owner_id = ctx.user.id` — an id that is not the
// caller's simply is not returned. Bounded: one query per call, for a page of
// ids a tool already holds.
// =============================================================================

import type { PrismaService } from '../../prisma/prisma.service';
import type { AskToolContext } from './ask-tool';
import { clip, QUOTE_MAX_CHARS } from './ask-tool';

/** Evidence rows shown inline per entry (timeline, commitments, brief). */
export const INLINE_EVIDENCE_PER_ENTRY = 2;

/** `{ ref, quote }` for the caller's own evidence ids, in the given order; unknown ids dropped. */
export async function evidenceRefsWithQuotes(
  prisma: Pick<PrismaService, 'kgEvidence'>,
  ctx: AskToolContext,
  ids: readonly string[],
): Promise<Map<string, { ref: string; quote: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const rows = await prisma.kgEvidence.findMany({
    where: { ownerId: ctx.user.id, id: { in: unique } },
    select: { id: true, quote: true },
  });
  const byId = new Map(rows.map((r) => [r.id, r.quote]));
  const out = new Map<string, { ref: string; quote: string }>();
  for (const id of unique) {
    const quote = byId.get(id);
    if (quote === undefined) continue;
    out.set(id, { ref: ctx.handles.register({ kind: 'ev', id }), quote: clip(quote, QUOTE_MAX_CHARS) });
  }
  return out;
}

/**
 * The first `perSubject` evidence ids (oldest first — the citation that
 * created the row) for each of the caller's subjects of one kind.
 */
export async function firstEvidenceIds(
  prisma: Pick<PrismaService, 'kgEvidence'>,
  ownerId: string,
  subjectKind: 'entity' | 'relation' | 'item',
  subjectIds: readonly string[],
  perSubject: number,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (subjectIds.length === 0) return out;
  const rows = await prisma.kgEvidence.findMany({
    where: { ownerId, subjectKind, subjectId: { in: [...new Set(subjectIds)] } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, subjectId: true },
  });
  for (const r of rows) {
    const list = out.get(r.subjectId) ?? [];
    if (list.length < perSubject) list.push(r.id);
    out.set(r.subjectId, list);
  }
  return out;
}
