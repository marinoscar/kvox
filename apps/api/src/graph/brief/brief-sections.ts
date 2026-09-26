// =============================================================================
// Brief sections — rows in, the five cited sections out (#372; spec §9.1)
// =============================================================================
//
// PURE: no Prisma, no Nest, no clock. `EntityBriefService` loads bounded,
// owner-scoped, readable rows and hands them here; this file decides which
// row belongs in which section. The five section names and their order are
// fixed by spec §9.1: What changed · Decisions · Open commitments (theirs /
// yours) · Risks / claims · People changes.
//
// Rules that hold for every section:
//   - `sensitive` person facts are NEVER included (§5.6, §15) — filtered here
//     as well as in SQL, so a caller that forgot the SQL filter still cannot
//     leak one into a brief;
//   - an entry with no evidence is dropped: every statement a brief makes is
//     cited (§5.3), and the response schema requires ≥ 1 evidence id;
//   - "People changes" reads the ontology's `exclusive: 'soft'` flag (#350) —
//     the caller passes the set derived from the registry, never a hardcoded
//     list of relation types.
// =============================================================================

import { isValidAt, type ValidRange } from '../temporal';
import {
  BRIEF_ENTRY_EVIDENCE_IDS,
  BRIEF_SECTION_LIMITS,
  type BriefEntityRef,
  type BriefEntry,
  type BriefSections,
  type PeopleChange,
} from './dto/entity-brief.dto';

export type BriefItemKind = 'commitment' | 'decision' | 'claim' | 'person_fact';
type Precision = 'day' | 'month' | 'year' | 'unknown';

/** One `kg_items` row as the brief reads it (statuses: accepted, edited, superseded). */
export interface BriefItemRow {
  id: string;
  kind: BriefItemKind;
  title: string | null;
  statement: string;
  status: string | null;
  occurredAt: Date | null;
  dueAt: Date | null;
  precision: string | null;
  subjectId: string | null;
  ownerPersonId: string | null;
  counterpartyId: string | null;
  meetingId: string | null;
  reviewStatus: string;
  supersededById: string | null;
  /** `occurred_at` of the item that superseded this one, when known. */
  supersededByOccurredAt: Date | null;
  sensitivity: string | null;
  valid: ValidRange | null;
  evidenceIds: string[];
}

/** One relation of an `exclusive: 'soft'` type, as the brief reads it. */
export interface BriefRelationRow {
  id: string;
  type: string;
  fromId: string;
  toId: string;
  props: Record<string, unknown>;
  /** `lower(valid)`, null when unbounded below. */
  validFrom: Date | null;
  /** `upper(valid)`, null when unbounded above (still open). */
  validTo: Date | null;
  precision: string | null;
  evidenceIds: string[];
}

export interface BriefSectionInput {
  entity: { id: string; type: string };
  /** Window start (exclusive); null = no lower bound. */
  since: Date | null;
  /** Window end (inclusive) and the instant every validity is evaluated at. */
  asOf: Date;
  items: readonly BriefItemRow[];
  relations: readonly BriefRelationRow[];
  /** Relation type keys declared `exclusive: 'soft'` in the caller's effective schema. */
  exclusiveTypes: ReadonlySet<string>;
  /** Persons with a `WORKS_FOR` to this entity valid at `asOf` (non-Person entities only). */
  workerIds: ReadonlySet<string>;
  /** Readable entities by id (for owner/counterparty/person/other refs). */
  entities: ReadonlyMap<string, BriefEntityRef>;
}

/** Relation types whose edges §5.4's closing rule closes — from the registry, never a literal list. */
export function exclusiveRelationTypes(
  relationTypes: readonly { key: string; exclusive: 'soft' | 'none' }[],
): Set<string> {
  return new Set(relationTypes.filter((r) => r.exclusive === 'soft').map((r) => r.key));
}

const asPrecision = (p: string | null, fallback: Precision): Precision =>
  p === 'day' || p === 'month' || p === 'year' || p === 'unknown' ? p : fallback;

const inWindow = (at: Date | null, since: Date | null, asOf: Date): boolean =>
  at !== null && at.getTime() <= asOf.getTime() && (since === null || at.getTime() > since.getTime());

/** Newest first, undated last, id as the tie-break — deterministic. */
function byOccurredDesc(a: BriefItemRow, b: BriefItemRow): number {
  const at = a.occurredAt?.getTime() ?? -Infinity;
  const bt = b.occurredAt?.getTime() ?? -Infinity;
  if (at !== bt) return bt - at;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

/** A `sensitive` person fact — never in a brief. */
export function isSensitive(item: Pick<BriefItemRow, 'kind' | 'sensitivity'>): boolean {
  return item.kind === 'person_fact' && item.sensitivity === 'sensitive';
}

/**
 * Whether the item had been superseded AS OF `asOf`: marked superseded (or
 * pointing at a successor) and the successor was stated by then. A successor
 * of unknown date counts — the row's own status is the authority.
 */
export function supersededAt(item: BriefItemRow, asOf: Date): boolean {
  if (item.reviewStatus !== 'superseded' && item.supersededById === null) return false;
  if (item.supersededByOccurredAt === null) return true;
  return item.supersededByOccurredAt.getTime() <= asOf.getTime();
}

/** Valid at `asOf` (range contains it, and it had been stated by then). */
function validAt(item: BriefItemRow, asOf: Date): boolean {
  if (!isValidAt(item.valid, asOf)) return false;
  return item.occurredAt === null || item.occurredAt.getTime() <= asOf.getTime();
}

function touches(item: BriefItemRow, id: string): boolean {
  return item.subjectId === id || item.ownerPersonId === id || item.counterpartyId === id || item.meetingId === id;
}

export function toBriefEntry(
  item: BriefItemRow,
  asOf: Date,
  entities: ReadonlyMap<string, BriefEntityRef>,
): BriefEntry {
  return {
    itemId: item.id,
    kind: item.kind,
    title: item.title,
    statement: item.statement,
    occurredAt: item.occurredAt ? item.occurredAt.toISOString() : null,
    precision: asPrecision(item.precision, item.occurredAt ? 'day' : 'unknown'),
    status: item.status,
    dueAt: item.dueAt ? item.dueAt.toISOString() : null,
    ownerPerson: item.ownerPersonId ? (entities.get(item.ownerPersonId) ?? null) : null,
    counterparty: item.counterpartyId ? (entities.get(item.counterpartyId) ?? null) : null,
    superseded: supersededAt(item, asOf),
    evidenceIds: item.evidenceIds.slice(0, BRIEF_ENTRY_EVIDENCE_IDS),
  };
}

/** The five sections. See the header for the rules every section shares. */
export function buildBriefSections(input: BriefSectionInput): BriefSections {
  const { entity, since, asOf, entities } = input;
  const eligible = input.items
    .filter((i) => !isSensitive(i) && i.evidenceIds.length > 0)
    .filter((i) => i.occurredAt === null || i.occurredAt.getTime() <= asOf.getTime())
    .slice()
    .sort(byOccurredDesc);
  const about = eligible.filter((i) => touches(i, entity.id));
  const entry = (i: BriefItemRow) => toBriefEntry(i, asOf, entities);

  // What changed: every item about the entity stated inside (since, asOf].
  const whatChanged = about
    .filter((i) => inWindow(i.occurredAt, since, asOf))
    .slice(0, BRIEF_SECTION_LIMITS.whatChanged)
    .map(entry);

  // Decisions valid at asOf; one superseded LATER still stood then (flagged by `superseded`: false).
  const decisions = about
    .filter((i) => i.kind === 'decision' && validAt(i, asOf))
    .filter((i) => i.reviewStatus !== 'superseded' || !supersededAt(i, asOf))
    .slice(0, BRIEF_SECTION_LIMITS.decisions)
    .map(entry);

  // Open commitments: open, valid at asOf, never a superseded row.
  const open = eligible.filter(
    (i) => i.kind === 'commitment' && i.status === 'open' && i.reviewStatus !== 'superseded' && validAt(i, asOf),
  );
  const isPerson = entity.type === 'Person';
  const theirs = open
    .filter((i) =>
      isPerson
        ? i.ownerPersonId === entity.id
        : i.ownerPersonId !== null && input.workerIds.has(i.ownerPersonId),
    )
    .slice(0, BRIEF_SECTION_LIMITS.openCommitments)
    .map(entry);
  const yours = open
    .filter((i) => i.counterpartyId === entity.id)
    .slice(0, BRIEF_SECTION_LIMITS.openCommitments)
    .map(entry);

  // Risks / claims: in the window, else the newest valid ones.
  const claims = about.filter((i) => i.kind === 'claim' && i.reviewStatus !== 'superseded');
  const windowed = claims.filter((i) => inWindow(i.occurredAt, since, asOf));
  const risksClaims = (windowed.length > 0 ? windowed : claims.filter((i) => validAt(i, asOf)))
    .slice(0, BRIEF_SECTION_LIMITS.risksClaims)
    .map(entry);

  return {
    whatChanged,
    decisions,
    openCommitments: { theirs, yours },
    risksClaims,
    peopleChanges: buildPeopleChanges(input),
  };
}

/**
 * Every start and every finite end of an exclusive-type edge inside
 * (since, asOf] — a promotion reads as one `ended` HAS_ROLE plus one
 * `started` HAS_ROLE. Newest first; both ends must be readable entities.
 */
export function buildPeopleChanges(input: BriefSectionInput): PeopleChange[] {
  const { since, asOf, entities } = input;
  const out: PeopleChange[] = [];
  for (const r of input.relations) {
    if (!input.exclusiveTypes.has(r.type) || r.evidenceIds.length === 0) continue;
    const person = entities.get(r.fromId);
    const other = entities.get(r.toId);
    if (!person || !other) continue;
    const title = typeof r.props.title === 'string' ? r.props.title : null;
    const base = {
      relationId: r.id,
      type: r.type,
      precision: asPrecision(r.precision, 'unknown'),
      person,
      other,
      title,
      evidenceIds: r.evidenceIds.slice(0, BRIEF_ENTRY_EVIDENCE_IDS),
    };
    if (inWindow(r.validFrom, since, asOf)) out.push({ ...base, change: 'started', at: r.validFrom!.toISOString() });
    if (inWindow(r.validTo, since, asOf)) out.push({ ...base, change: 'ended', at: r.validTo!.toISOString() });
  }
  out.sort((a, b) => {
    if (a.at !== b.at) return a.at < b.at ? 1 : -1;
    // Same instant (a closing rule): the end before the start reads as a sequence.
    if (a.change !== b.change) return a.change === 'ended' ? -1 : 1;
    return a.relationId < b.relationId ? -1 : a.relationId > b.relationId ? 1 : 0;
  });
  return out.slice(0, BRIEF_SECTION_LIMITS.peopleChanges);
}
