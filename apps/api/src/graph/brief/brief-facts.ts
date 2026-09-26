// =============================================================================
// The digest's numbered fact list (#372; spec §9.2, §15)
// =============================================================================
//
// PURE. Turns the previous digest, the new items and the currently open
// exclusive relations into `F1 … Fn` — the ONLY thing `kg.entity_digest`
// shows the model. Each handle maps to evidence ids that stay SERVER-SIDE:
// the model cites `F3`, never a uuid, so citation validation is a map lookup
// and a hallucinated reference is simply an unknown handle.
//
// PRIVACY (§5.6, §15), enforced here as well as in SQL:
//   - a `sensitive` person fact NEVER becomes a fact, under any setting;
//   - a `personal` person fact only with the §14 personal-facts-in-prompts
//     opt-in (`includePersonalFacts`), which today is always false.
// =============================================================================

/** At most this many facts go into one prompt. */
export const DIGEST_MAX_FACTS = 200;
/** Of which at most this many are open relations (the rest are items). */
export const DIGEST_MAX_RELATION_FACTS = 50;
/** Evidence ids a single fact carries (server-side). */
export const DIGEST_FACT_EVIDENCE_IDS = 5;

export interface DigestPreviousStatement {
  text: string;
  evidenceIds: string[];
}

export interface DigestItemFact {
  kind: 'commitment' | 'decision' | 'claim' | 'person_fact';
  title: string | null;
  statement: string;
  status: string | null;
  occurredAt: Date | null;
  dueAt: Date | null;
  sensitivity: string | null;
  evidenceIds: string[];
}

export interface DigestRelationFact {
  /** Ontology label, e.g. "Has role". */
  typeLabel: string;
  fromLabel: string;
  toLabel: string;
  title: string | null;
  validFrom: Date | null;
  /** Finite end — the edge has closed (a promotion, a manager change). */
  validTo: Date | null;
  evidenceIds: string[];
}

export interface DigestFact {
  handle: string;
  /** `YYYY-MM-DD`, or null when undated. */
  date: string | null;
  /** `previous`, an item kind, or `relation`. */
  kind: string;
  text: string;
}

export interface DigestFactList {
  facts: DigestFact[];
  /** Handle → evidence ids. Never sent to the model. */
  evidenceByHandle: Map<string, string[]>;
  /** Handles of the previous statements (the model may keep or drop them). */
  previousHandles: string[];
}

export interface BuildFactListInput {
  previous: readonly DigestPreviousStatement[];
  /** Newest first. */
  items: readonly DigestItemFact[];
  relations: readonly DigestRelationFact[];
  includePersonalFacts: boolean;
  maxFacts?: number;
}

const day = (d: Date | null): string | null => (d ? d.toISOString().slice(0, 10) : null);

/** Whether an item may be put into a prompt at all (§15). */
export function itemAllowedInPrompt(
  item: Pick<DigestItemFact, 'kind' | 'sensitivity'>,
  includePersonalFacts: boolean,
): boolean {
  if (item.kind !== 'person_fact') return true;
  if (item.sensitivity === 'sensitive') return false;
  if (item.sensitivity === 'business') return true;
  // `personal`, or unclassified (treated as personal — the §5.6 default).
  return includePersonalFacts;
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

export function buildDigestFactList(input: BuildFactListInput): DigestFactList {
  const max = input.maxFacts ?? DIGEST_MAX_FACTS;
  const facts: DigestFact[] = [];
  const evidenceByHandle = new Map<string, string[]>();
  const previousHandles: string[] = [];

  const push = (kind: string, date: string | null, text: string, evidenceIds: readonly string[]): string | null => {
    if (facts.length >= max) return null;
    const ids = [...new Set(evidenceIds)].slice(0, DIGEST_FACT_EVIDENCE_IDS);
    const clean = oneLine(text);
    if (ids.length === 0 || clean.length === 0) return null;
    const handle = `F${facts.length + 1}`;
    facts.push({ handle, date, kind, text: clean });
    evidenceByHandle.set(handle, ids);
    return handle;
  };

  for (const s of input.previous) {
    // A previous statement carries up to 8 ids; keep them all behind its handle.
    if (facts.length >= max) break;
    const clean = oneLine(s.text);
    const ids = [...new Set(s.evidenceIds)];
    if (clean.length === 0 || ids.length === 0) continue;
    const handle = `F${facts.length + 1}`;
    facts.push({ handle, date: null, kind: 'previous', text: clean });
    evidenceByHandle.set(handle, ids);
    previousHandles.push(handle);
  }

  for (const r of input.relations.slice(0, DIGEST_MAX_RELATION_FACTS)) {
    const when = r.validTo
      ? `from ${day(r.validFrom) ?? 'an unknown date'} until ${day(r.validTo)} (ended)`
      : `since ${day(r.validFrom) ?? 'an unknown date'}`;
    const text = `${r.fromLabel} — ${r.typeLabel} — ${r.toLabel}${r.title ? ` (${r.title})` : ''}, ${when}`;
    push('relation', day(r.validTo ?? r.validFrom), text, r.evidenceIds);
  }

  for (const i of input.items) {
    if (!itemAllowedInPrompt(i, input.includePersonalFacts)) continue;
    const parts = [i.title ? `${i.title}: ${i.statement}` : i.statement];
    if (i.kind === 'commitment' && i.status) parts.push(`(status: ${i.status}${i.dueAt ? `, due ${day(i.dueAt)}` : ''})`);
    push(i.kind, day(i.occurredAt), parts.join(' '), i.evidenceIds);
  }

  return { facts, evidenceByHandle, previousHandles };
}
