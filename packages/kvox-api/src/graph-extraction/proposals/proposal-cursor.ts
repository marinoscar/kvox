// =============================================================================
// The proposal list cursor (#366; docs/specs/ontology.md §8)
// =============================================================================
//
// Keyset pagination over `(created_at desc, id desc)`, carried as an opaque
// base64url string. A cursor that does not decode is a 400, never a silent
// restart from the top — the `search-cursor.ts` posture: a client holding a
// cursor it cannot use should know it, not be handed page 1 again under a
// "next page" it just asked for.
//
// PURE.
// =============================================================================

import { BadRequestException } from '@nestjs/common';

export interface ProposalCursor {
  createdAt: Date;
  id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const INVALID_PROPOSAL_CURSOR_MESSAGE = 'The cursor is not valid for this list. Start again from the first page.';

export function encodeProposalCursor(cursor: ProposalCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt.toISOString(), i: cursor.id }), 'utf8').toString('base64url');
}

/** Decode, or throw a 400. */
export function decodeProposalCursor(raw: string): ProposalCursor {
  const invalid = () => new BadRequestException(INVALID_PROPOSAL_CURSOR_MESSAGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  if (!parsed || typeof parsed !== 'object') throw invalid();
  const { c, i } = parsed as { c?: unknown; i?: unknown };
  if (typeof c !== 'string' || typeof i !== 'string' || !UUID.test(i)) throw invalid();
  const createdAt = new Date(c);
  if (Number.isNaN(createdAt.getTime())) throw invalid();
  return { createdAt, id: i.toLowerCase() };
}
