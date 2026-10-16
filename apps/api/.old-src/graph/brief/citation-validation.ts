// =============================================================================
// Citation validation for the entity digest (#372; spec §5.3, §9.2)
// =============================================================================
//
// PURE. Every statement the model writes must cite at least one KNOWN fact
// handle. A statement with no `factRefs`, or naming a handle that was never in
// the fact list, is dropped — never stored, and counted in `dropped`. Handles
// are mapped to their server-side evidence ids (deduplicated, at most eight).
// Zero surviving statements is a failure: the job throws and the previous
// digest is kept.
// =============================================================================

import { DIGEST_STATEMENT_EVIDENCE_IDS, type CitedStatement } from './dto/entity-brief.dto';
import { DIGEST_MAX_STATEMENTS } from './brief-prompt';

export interface ModelStatement {
  text: string;
  factRefs: readonly string[];
}

export interface CitationValidationResult {
  statements: CitedStatement[];
  dropped: number;
}

/** Every statement was dropped: the answer cannot be stored. */
export class DigestCitationError extends Error {
  constructor(readonly dropped: number) {
    super(`Every statement in the digest answer lacked a valid citation (${dropped} dropped).`);
    this.name = 'DigestCitationError';
  }
}

export function validateDigestCitations(
  statements: readonly ModelStatement[],
  evidenceByHandle: ReadonlyMap<string, readonly string[]>,
  maxStatements = DIGEST_MAX_STATEMENTS,
): CitationValidationResult {
  const kept: CitedStatement[] = [];
  let dropped = 0;

  for (const s of statements) {
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    const refs = Array.isArray(s.factRefs) ? s.factRefs.map((r) => String(r).trim()) : [];
    if (text.length === 0 || refs.length === 0 || refs.some((r) => !evidenceByHandle.has(r))) {
      dropped += 1;
      continue;
    }
    if (kept.length >= maxStatements) {
      dropped += 1;
      continue;
    }
    const ids: string[] = [];
    for (const ref of refs) {
      for (const id of evidenceByHandle.get(ref)!) {
        if (!ids.includes(id)) ids.push(id);
      }
    }
    kept.push({ text, evidenceIds: ids.slice(0, DIGEST_STATEMENT_EVIDENCE_IDS) });
  }

  if (kept.length === 0) throw new DigestCitationError(dropped);
  return { statements: kept, dropped };
}

/** The stored `citations` JSON → statements, defensively (it is our own shape, version 1). */
export function readDigestStatements(citations: unknown): CitedStatement[] {
  if (!citations || typeof citations !== 'object') return [];
  const statements = (citations as { statements?: unknown }).statements;
  if (!Array.isArray(statements)) return [];
  const out: CitedStatement[] = [];
  for (const s of statements) {
    if (!s || typeof s !== 'object') continue;
    const { text, evidenceIds } = s as { text?: unknown; evidenceIds?: unknown };
    if (typeof text !== 'string' || !Array.isArray(evidenceIds)) continue;
    const ids = evidenceIds.filter((id): id is string => typeof id === 'string');
    if (ids.length > 0) out.push({ text, evidenceIds: ids.slice(0, DIGEST_STATEMENT_EVIDENCE_IDS) });
  }
  return out;
}
