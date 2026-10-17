// =============================================================================
// Manual evidence (#586; docs/specs/ontology.md §5.3, §8)
// =============================================================================
//
// A citation whose source is THE OWNER, stating a fact by hand on an entity
// page (§8's manual-edit exception) — "Set by hand: Jenny Kim reports to Mark
// Chen". It has no transcript, note or import anchor, so it can never pass
// `evidenceInputSchema` (which demands one) and it never goes through
// `EvidenceValidator`: there is nothing to prove readable.
//
// WHY A CLASS. `GraphWriteService` recognises a manual citation with
// `instanceof ManualEvidence`, never by a field: wire JSON (a proposal item,
// an import, a stored payload) can only ever produce plain objects, so no
// client can author one. Only server code that constructs it — today
// `GraphEntitiesService`'s manual relation edit — can.
//
// STORAGE, NO MIGRATION. The row is an ordinary `kg_evidence` row with every
// anchor NULL, `quote` the sentence above and `source_iri` the reserved
// `MANUAL_EVIDENCE_SOURCE_IRI` — the one marker that tells it apart from a
// row whose anchors went NULL because its source was deleted. Readers report
// it as `source.kind: 'manual'`; `evidenceInputSchema` refuses the IRI, so it
// cannot be forged through the wire either.
//
// ⚠ The quote names people: never log it.
// =============================================================================

import { MANUAL_EVIDENCE_SOURCE_IRI, type EvidenceInput } from '@marinoscar/kvox-contract/graph';

/** The longest quote `kg_evidence` takes from any writer (`evidenceInputSchema`). */
const QUOTE_MAX = 2000;

/**
 * How every reader labels a manual citation (the Ask citation chip, the
 * `evidence` tool's source title).
 *
 * @stability experimental
 */
export const MANUAL_EVIDENCE_LABEL = 'Set by hand';

/**
 * One server-authored manual citation. Construct it only in server code.
 *
 * @stability experimental
 */
export class ManualEvidence {
  /** The sentence the citation reads as, trimmed and clipped to 2000 characters. */
  readonly quote: string;

  constructor(quote: string) {
    const trimmed = quote.trim();
    if (trimmed.length === 0) throw new Error('A manual citation needs a quote.');
    this.quote = trimmed.slice(0, QUOTE_MAX);
  }

  /** The `kg_evidence` columns: every anchor NULL, the reserved source IRI. */
  toEvidenceInput(): EvidenceInput {
    return {
      transcriptId: null,
      segmentId: null,
      segmentRev: null,
      startMs: null,
      endMs: null,
      noteId: null,
      noteVersion: null,
      charStart: null,
      charEnd: null,
      quote: this.quote,
      importObjectId: null,
      sourceIri: MANUAL_EVIDENCE_SOURCE_IRI,
    };
  }
}

/**
 * What `GraphWriteService.createRelation` and `addEvidence` accept: a wire
 * citation (validated and proven readable) or a {@link ManualEvidence}.
 *
 * @stability experimental
 */
export type GraphEvidenceInput = EvidenceInput | ManualEvidence;

/**
 * Whether a stored `kg_evidence` row is a manual citation.
 *
 * @stability experimental
 */
export function isManualEvidenceRow(row: { sourceIri: string | null }): boolean {
  return row.sourceIri === MANUAL_EVIDENCE_SOURCE_IRI;
}
