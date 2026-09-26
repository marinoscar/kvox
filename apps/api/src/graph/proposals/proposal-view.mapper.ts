// =============================================================================
// Proposal view mapping (#366; docs/specs/ontology.md §8, §19)
// =============================================================================
//
// PURE. Turns `kg_proposals` / `kg_proposal_items` / `kg_evidence` rows into
// the Contract's view shapes. Everything a reviewer reads as prose — a row's
// group, its title and subtitle, whether a citation is stale, the counts — is
// computed HERE, once, so the web (#367) never re-derives it and the two can
// never disagree about what "stale" or "accepted" means.
//
// No Prisma, no Nest, no clock read: the service loads the rows and the
// lookup maps (labels, current revs, current note versions) and hands them in.
// =============================================================================

import type { EffectiveSchema } from '@app/shared/ontology';

import { userGuidanceSchema } from '../extraction/dto/extraction.dto';
import type { ProposalResolution } from './proposal-payload.schema';
import {
  GROUP_KEYS,
  type EvidenceView,
  type GroupKey,
  type ProposalCounts,
  type ProposalDecision,
  type ProposalItemKind,
  type ProposalItemView,
  type ProposalSummary,
} from './dto/proposal.dto';

// -----------------------------------------------------------------------------
// Inputs
// -----------------------------------------------------------------------------

export interface ProposalRowInput {
  id: string;
  kind: 'extraction' | 'import' | 'resolution';
  status: ProposalSummary['status'];
  noteId: string | null;
  noteVersion: number | null;
  model: string | null;
  provider: string | null;
  userGuidance: unknown;
  stats: unknown;
  committedAt: Date | null;
  revertedAt: Date | null;
  createdAt: Date;
}

export interface ProposalItemRowInput {
  id: string;
  kind: ProposalItemKind;
  origin: 'ai' | 'user';
  decision: ProposalDecision;
  payload: unknown;
  editedPayload: unknown;
  resolution: unknown;
  mergeIntoId: string | null;
  distinctFrom: string[];
  flags: string[];
  committedRefId: string | null;
  sortOrder: number;
}

export interface EvidenceRowInput {
  id: string;
  subjectId: string;
  transcriptId: string | null;
  segmentId: string | null;
  segmentRev: number | null;
  startMs: number | null;
  endMs: number | null;
  noteId: string | null;
  noteVersion: number | null;
  charStart: number | null;
  charEnd: number | null;
  quote: string;
}

/** What the mapper looks up; the service fills it with bounded queries. */
export interface ViewLookups {
  /** Type and relation labels. Absent keys fall back to the raw key. */
  schema: Pick<EffectiveSchema, 'entityType' | 'relationType'> | null;
  /** Labels of existing entities named by `{ entityId }`, `resolution.ref`, `mergeIntoId`. */
  entityLabels: ReadonlyMap<string, string>;
  /** Segment id → its current rev and the speaker's display name. */
  segments: ReadonlyMap<string, { rev: number; speakerName: string | null }>;
  /** Note id → its current version. */
  noteVersions: ReadonlyMap<string, number>;
  /** Item ids the extraction pre-check ticked. */
  prechecked: ReadonlySet<string>;
}

type Json = Record<string, unknown>;

// -----------------------------------------------------------------------------
// Small helpers
// -----------------------------------------------------------------------------

export function asObject(value: unknown): Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {};
}

/** `editedPayload ?? payload` — the payload the commit will use. */
export function effectivePayloadOf(row: Pick<ProposalItemRowInput, 'payload' | 'editedPayload'>): Json {
  const edited = row.editedPayload;
  return edited !== null && edited !== undefined && typeof edited === 'object' ? asObject(edited) : asObject(row.payload);
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** `kg_items.kind` → its core/work ontology type key. */
export const ITEM_KIND_TYPE_KEYS: Readonly<Record<string, GroupKey>> = {
  commitment: 'Commitment',
  decision: 'Decision',
  claim: 'Claim',
  person_fact: 'PersonFact',
};

const ENTITY_GROUPS: ReadonlySet<string> = new Set(['Person', 'Organization', 'Project', 'Meeting']);

export const DECIDED_ACCEPT: ReadonlySet<ProposalDecision> = new Set<ProposalDecision>(['accept', 'edit', 'merge_into']);

// -----------------------------------------------------------------------------
// Group keys and ordering
// -----------------------------------------------------------------------------

export function groupKeyOf(kind: ProposalItemKind, effective: Json): GroupKey {
  switch (kind) {
    case 'relation':
      return 'relations';
    case 'closing':
      return 'closings';
    case 'item':
      return ITEM_KIND_TYPE_KEYS[String(effective.kind)] ?? 'Other';
    case 'entity': {
      const type = String(effective.type ?? '');
      return ENTITY_GROUPS.has(type) ? (type as GroupKey) : 'Other';
    }
  }
}

const GROUP_ORDER = new Map<GroupKey, number>(GROUP_KEYS.map((k, i) => [k, i]));

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * `2026-03-04` at `day` → `Mar 4, 2026`; at `month` → `Mar 2026`; at `year` →
 * `2026` — the same spelling `formatValid` (#353) uses. `unknown` precision,
 * or a string that is not a date, is returned as written.
 */
export function formatDateAtPrecision(iso: string, precision: string): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(iso.trim());
  if (!m) return iso;
  const [, y, mo, d] = m;
  const month = mo ? MONTHS[Number(mo) - 1] : undefined;
  if (precision === 'year' || !month) return y;
  if (precision === 'month' || !d) return `${month} ${y}`;
  if (precision === 'day') return `${month} ${Number(d)}, ${y}`;
  return iso;
}

/** A proposal row's validity period in words, or null when it has none. */
export function formatPeriod(validFrom: unknown, validTo: unknown, precision: unknown): string | null {
  const p = typeof precision === 'string' ? precision : 'unknown';
  if (p === 'unknown') return null;
  const from = str(validFrom);
  const to = str(validTo);
  if (from && to) {
    const a = formatDateAtPrecision(from, p);
    const b = formatDateAtPrecision(to, p);
    return a === b ? a : `${a} → ${b}`;
  }
  if (from) return `since ${formatDateAtPrecision(from, p)}`;
  if (to) return `until ${formatDateAtPrecision(to, p)}`;
  return null;
}

// -----------------------------------------------------------------------------
// Display strings
// -----------------------------------------------------------------------------

function typeLabel(lookups: ViewLookups, key: string): string {
  return lookups.schema?.entityType(key)?.label ?? key;
}

function relationLabel(lookups: ViewLookups, key: string): string {
  return lookups.schema?.relationType(key)?.label ?? key;
}

/** Label of an endpoint: `{ ref }` → that proposal row's label; `{ entityId }` → the entity's. */
export function endpointLabel(endpoint: unknown, refLabels: ReadonlyMap<string, string>, lookups: ViewLookups): string | null {
  const e = asObject(endpoint);
  if (typeof e.ref === 'string') return refLabels.get(e.ref) ?? e.ref;
  if (typeof e.entityId === 'string') return lookups.entityLabels.get(e.entityId) ?? 'Unknown entity';
  return null;
}

const joinParts = (parts: Array<string | null | undefined>): string | null => {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p !== '');
  return kept.length > 0 ? kept.join(' · ') : null;
};

export function displayOf(
  kind: ProposalItemKind,
  effective: Json,
  refLabels: ReadonlyMap<string, string>,
  lookups: ViewLookups,
): { title: string; subtitle: string | null } {
  switch (kind) {
    case 'entity': {
      const type = String(effective.type ?? '');
      const occurredAt = str(effective.occurredAt);
      return {
        title: str(effective.label) ?? '(unnamed)',
        subtitle: joinParts([typeLabel(lookups, type), occurredAt ? formatDateAtPrecision(occurredAt, 'day') : null]),
      };
    }
    case 'relation': {
      const type = String(effective.type ?? '');
      const label = relationLabel(lookups, type);
      const from = endpointLabel(effective.from, refLabels, lookups) ?? '?';
      const to = endpointLabel(effective.to, refLabels, lookups) ?? '?';
      const props = asObject(effective.props);
      return {
        title: `${from} → ${label.toLowerCase()} → ${to}`,
        subtitle: joinParts([label, str(props.title), formatPeriod(effective.validFrom, effective.validTo, effective.precision)]),
      };
    }
    case 'item': {
      const itemKind = String(effective.kind ?? '');
      const key = ITEM_KIND_TYPE_KEYS[itemKind] ?? itemKind;
      const owner = endpointLabel(effective.owner, refLabels, lookups);
      const due = str(effective.dueAt);
      const occurred = str(effective.occurredAt);
      const parts: Array<string | null> = [typeLabel(lookups, key)];
      if (itemKind === 'commitment') {
        parts.push(owner, due ? `due ${formatDateAtPrecision(due, 'day')}` : null);
      } else {
        const subject = endpointLabel(effective.subject, refLabels, lookups);
        parts.push(subject, occurred ? formatDateAtPrecision(occurred, 'day') : null);
      }
      parts.push(formatPeriod(effective.validFrom, effective.validTo, effective.precision));
      return { title: str(effective.title) ?? str(effective.statement) ?? '(untitled)', subtitle: joinParts(parts) };
    }
    case 'closing': {
      // #365's copy contract: `Closes: {fromLabel} {relation label} {toLabel}{, as roleTitle},
      // {previousValid.from at its precision} → {closeAt at its precision}`.
      const relationType = String(effective.relationType ?? '');
      const label = relationLabel(lookups, relationType).toLowerCase();
      const previous = asObject(effective.previousValid);
      const prevFrom = str(previous.from);
      const prevPrecision = typeof previous.precision === 'string' ? previous.precision : 'unknown';
      const closeAt = str(effective.closeAt);
      const closePrecision = typeof effective.precision === 'string' ? effective.precision : 'day';
      const role = str(effective.roleTitle);
      const fromText = prevFrom && prevPrecision !== 'unknown' ? formatDateAtPrecision(prevFrom, prevPrecision) : '…';
      const toText = closeAt ? formatDateAtPrecision(closeAt, closePrecision) : '…';
      const affected = Array.isArray(effective.affectedCommitments) ? effective.affectedCommitments.length : 0;
      return {
        title: `Closes: ${str(effective.fromLabel) ?? '?'} ${label} ${str(effective.toLabel) ?? '?'}${role ? `, as ${role}` : ''}, ${fromText} → ${toText}`,
        subtitle: affected > 0 ? `Affects ${affected} open commitment${affected === 1 ? '' : 's'}` : null,
      };
    }
  }
}

// -----------------------------------------------------------------------------
// Evidence
// -----------------------------------------------------------------------------

export function evidenceViewOf(e: EvidenceRowInput, lookups: ViewLookups): EvidenceView {
  const isSegment = e.segmentId !== null || e.transcriptId !== null || e.segmentRev !== null || e.startMs !== null;
  let stale: boolean;
  let speakerName: string | null = null;
  if (isSegment) {
    const current = e.segmentId ? lookups.segments.get(e.segmentId) : undefined;
    speakerName = current?.speakerName ?? null;
    stale = !current || e.segmentRev === null || current.rev !== e.segmentRev;
  } else {
    const current = e.noteId ? lookups.noteVersions.get(e.noteId) : undefined;
    stale = current === undefined || e.noteVersion === null || current !== e.noteVersion;
  }
  return {
    id: e.id,
    source: isSegment ? 'segment' : 'note',
    transcriptId: e.transcriptId,
    segmentId: e.segmentId,
    segmentRev: e.segmentRev,
    startMs: e.startMs,
    endMs: e.endMs,
    noteId: e.noteId,
    noteVersion: e.noteVersion,
    charStart: e.charStart,
    charEnd: e.charEnd,
    quote: e.quote,
    speakerName,
    stale,
  };
}

// -----------------------------------------------------------------------------
// Items
// -----------------------------------------------------------------------------

/** `ref → label` for every entity row of a proposal, from effective payloads. */
export function refLabelsOf(rows: readonly ProposalItemRowInput[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of rows) {
    if (row.kind !== 'entity') continue;
    const eff = effectivePayloadOf(row);
    if (typeof eff.ref === 'string' && typeof eff.label === 'string') out.set(eff.ref, eff.label);
  }
  return out;
}

function resolutionView(
  row: ProposalItemRowInput,
  lookups: ViewLookups,
): ProposalItemView['resolution'] {
  if (row.resolution === null || row.resolution === undefined || typeof row.resolution !== 'object') return null;
  const res = row.resolution as Partial<ProposalResolution>;
  const candidates = Array.isArray(res.candidates) ? res.candidates : [];
  const target = row.mergeIntoId ?? (typeof res.ref === 'string' ? res.ref : null);
  const refLabel = target
    ? (lookups.entityLabels.get(target) ?? candidates.find((c) => c.entityId === target)?.label ?? null)
    : null;
  return {
    ref: typeof res.ref === 'string' ? res.ref : null,
    score: typeof res.score === 'number' ? res.score : null,
    source: res.source ?? null,
    candidates,
    adjudication: res.adjudication ?? null,
    refLabel,
  };
}

export function itemViewOf(
  row: ProposalItemRowInput,
  evidence: readonly EvidenceRowInput[],
  refLabels: ReadonlyMap<string, string>,
  lookups: ViewLookups,
): ProposalItemView {
  const effective = effectivePayloadOf(row);
  const edited = row.editedPayload;
  return {
    id: row.id,
    kind: row.kind,
    origin: row.origin,
    groupKey: groupKeyOf(row.kind, effective),
    decision: row.decision,
    payload: asObject(row.payload),
    editedPayload: edited !== null && edited !== undefined && typeof edited === 'object' ? asObject(edited) : null,
    effectivePayload: effective,
    display: displayOf(row.kind, effective, refLabels, lookups),
    resolution: resolutionView(row, lookups),
    mergeIntoId: row.mergeIntoId,
    distinctFrom: [...row.distinctFrom],
    flags: [...row.flags],
    prechecked: lookups.prechecked.has(row.id),
    evidence: evidence.map((e) => evidenceViewOf(e, lookups)),
    committedRefId: row.committedRefId,
  };
}

/** Group order (the Contract's `groupKeySchema` order), then title, then extraction order. */
export function orderItemViews(views: ProposalItemView[], sortOrder: ReadonlyMap<string, number>): ProposalItemView[] {
  return [...views].sort(
    (a, b) =>
      (GROUP_ORDER.get(a.groupKey) ?? 99) - (GROUP_ORDER.get(b.groupKey) ?? 99) ||
      a.display.title.localeCompare(b.display.title) ||
      (sortOrder.get(a.id) ?? 0) - (sortOrder.get(b.id) ?? 0) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
}

// -----------------------------------------------------------------------------
// Counts and summary
// -----------------------------------------------------------------------------

export type CountableRow = Pick<ProposalItemRowInput, 'kind' | 'decision' | 'flags' | 'payload' | 'editedPayload'>;

export function countsOf(rows: readonly CountableRow[]): ProposalCounts {
  const byGroup = Object.fromEntries(GROUP_KEYS.map((k) => [k, 0])) as Record<GroupKey, number>;
  const counts: ProposalCounts = { total: rows.length, pending: 0, accepted: 0, rejected: 0, known: 0, byGroup };
  for (const row of rows) {
    if (row.decision === 'pending') counts.pending += 1;
    else if (row.decision === 'reject') counts.rejected += 1;
    else if (DECIDED_ACCEPT.has(row.decision)) counts.accepted += 1;
    if (row.flags.includes('known')) counts.known += 1;
    byGroup[groupKeyOf(row.kind, effectivePayloadOf(row))] += 1;
  }
  return counts;
}

/** `stats.prechecked` — the ids the extraction pre-check ticked (written by `ProposalWriter.finalize`). */
export function precheckedOf(stats: unknown): Set<string> {
  const list = asObject(stats).prechecked;
  return new Set(Array.isArray(list) ? list.filter((v): v is string => typeof v === 'string') : []);
}

/** Internal bookkeeping in `stats` that is not display data. */
const INTERNAL_STATS_KEYS = new Set(['prechecked']);

export function summaryOf(
  proposal: ProposalRowInput,
  note: { title: string; currentVersion: number } | null,
  counts: ProposalCounts,
): ProposalSummary {
  const stats = asObject(proposal.stats);
  const failureRaw = asObject(stats.failure);
  const failure =
    typeof failureRaw.errorClass === 'string' && typeof failureRaw.message === 'string'
      ? { errorClass: failureRaw.errorClass, message: failureRaw.message }
      : null;
  const guidance = proposal.userGuidance === null || proposal.userGuidance === undefined
    ? null
    : userGuidanceSchema.safeParse(proposal.userGuidance);
  return {
    id: proposal.id,
    kind: proposal.kind,
    status: proposal.status,
    noteId: proposal.noteId,
    noteTitle: note?.title ?? null,
    noteVersion: proposal.noteVersion,
    noteCurrentVersion: note?.currentVersion ?? null,
    model: proposal.model,
    providerId: proposal.provider,
    userGuidance: guidance && guidance.success ? guidance.data : null,
    counts,
    stats: Object.fromEntries(Object.entries(stats).filter(([k]) => !INTERNAL_STATS_KEYS.has(k))),
    failure,
    createdAt: proposal.createdAt.toISOString(),
    committedAt: proposal.committedAt ? proposal.committedAt.toISOString() : null,
    revertedAt: proposal.revertedAt ? proposal.revertedAt.toISOString() : null,
  };
}
