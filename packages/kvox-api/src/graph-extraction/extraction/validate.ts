// =============================================================================
// validateExtraction + the deterministic rows (#363; docs/specs/ontology.md §5.3, §6)
// =============================================================================
//
// PURE. Turns the model's answer into proposal rows the writer can persist,
// enforcing the no-orphans rule AT THE EXTRACTION BOUNDARY (§3.3):
//
//   1. The envelope is Zod-parsed; a malformed answer is `invalid_output` —
//      a failed proposal, never a partial one.
//   2. Per row: a type not offered → dropped (`unknownType`); props failing
//      #350's closed validator, an endpoint of the wrong type, an impossible
//      date range → dropped (`invalid`).
//   3. Per cite: a `source` not handed to the model → the cite is dropped; a
//      quote found in the segment (exact, then case/whitespace-normalized) →
//      offsets WITHIN THE SEGMENT TEXT; a real segment whose quote is not found
//      → whole-segment evidence (first 300 chars) + flag `quote_not_located`;
//      a note cite whose quote is not in the body → dropped; a Context cite
//      (`C`, #440, only when the note has a non-blank Context) whose quote is
//      in the Context → a NOTE citation with NULL offsets (the `kg_evidence`
//      convention for "the note's Context field"), else dropped.
//   4. A row with no surviving cite → dropped (`uncited`); then every relation
//      or item whose endpoint entity was dropped → dropped (`dangling`).
//      Entities are the only endpoints, so one pass after the entity pass is
//      already the fixed point.
//   5. Dates: an unparseable date → null (+ `precision: 'unknown'` for a
//      validity bound); `validFrom > validTo` → dropped (`invalid`), never
//      swapped.
//
// `addDeterministicRows` then adds what the model never emits: the Meeting row
// (ref `meeting`) and one ATTENDED row per identified speaker. Every
// commitment/decision gets `meeting: { ref: 'meeting' }`.
//
// A document or record (#780) is the one source that may hold several meetings: the
// model may propose Meetings, and when it proposes two or more the system Meeting is
// not added (see `addDeterministicRows`). Such a note also gets one system Document
// row (ref `document`) with RECORDED_IN from each meeting and, when the owner's own
// Person is known, PREPARED_FOR to it.
// =============================================================================

import { buildPropsSchema, type EffectiveEntityType, type EffectiveSchema } from '@marinoscar/kvox-contract/ontology';

import {
  type EndpointRef,
  type EntityPayload,
  type ItemPayload,
  type ItemPayloadKind,
  type ProposalItemFlag,
  type ProposalResolution,
  type RelationPayload,
} from '../proposals/proposal-payload.schema.js';
import { statementHash } from '../../graph/index.js';
import {
  CONTEXT_ALIAS,
  SOURCE_ALIAS,
  DOCUMENT_REF,
  MEETING_REF,
  NOTE_ALIAS,
  normalizeForMatch,
  offeredContextText,
  type ExtractionContext,
  type SegmentAliasEntry,
} from './extraction-context.js';
import {
  EXTRACTABLE_ITEM_STATUSES,
  rawExtractionSchema,
  type RawCite,
  type RawEntity,
  type RawItem,
  type RawRelation,
} from './output-schema.js';

/** A whole-segment citation's quote length. */
export const WHOLE_SEGMENT_QUOTE_CHARS = 300;
/** The longest quote kept from the model (the prompt asks for ≤ 200). */
export const MAX_QUOTE_CHARS = 400;

export type EvidenceDraft =
  | {
      source: 'segment';
      transcriptId: string;
      segmentId: string;
      segmentRev: number;
      startMs: number;
      endMs: number;
      /** Offsets within the segment's text; null = the whole segment. */
      charStart: number | null;
      charEnd: number | null;
      quote: string;
    }
  | {
      source: 'note';
      noteId: string;
      noteVersion: number;
      /**
       * Offsets within the note version's body; both null = a quote from the
       * note's Context field (#440), which has no stable offsets of its own.
       */
      charStart: number | null;
      charEnd: number | null;
      quote: string;
    }
  | {
      /**
       * A span of the full text the note was generated from (#789). `charStart`/`charEnd`
       * index that text (`sourceObjectId`, `sourceTextLength` long), never the note body;
       * `noteId`/`noteVersion` name the note for the deep link.
       */
      source: 'source_text';
      noteId: string;
      noteVersion: number;
      sourceObjectId: string;
      sourceTextLength: number;
      charStart: number;
      charEnd: number;
      quote: string;
    };

export type ProposedRow =
  | { kind: 'entity'; payload: EntityPayload; resolution: ProposalResolution | null; flags: ProposalItemFlag[]; evidence: EvidenceDraft[] }
  | { kind: 'relation'; payload: RelationPayload; resolution: null; flags: ProposalItemFlag[]; evidence: EvidenceDraft[] }
  | { kind: 'item'; payload: ItemPayload; resolution: null; flags: ProposalItemFlag[]; evidence: EvidenceDraft[] };

export interface ValidationStats {
  proposed: { entities: number; relations: number; items: number };
  dropped: { uncited: number; invalid: number; unknownType: number; dangling: number };
  quoteNotLocated: number;
}

export type ValidationResult =
  | { ok: true; rows: ProposedRow[]; topics: string[]; stats: ValidationStats }
  | { ok: false; errorClass: 'invalid_output'; message: string };

// -----------------------------------------------------------------------------
// Quotes
// -----------------------------------------------------------------------------

/** Lowercased text with every whitespace run collapsed to one space, plus a map back. */
function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = '';
  const map: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace && folded.length > 0) {
        folded += ' ';
        map.push(i);
      }
      inSpace = true;
      continue;
    }
    inSpace = false;
    folded += ch.toLowerCase();
    map.push(i);
  }
  if (folded.endsWith(' ')) {
    folded = folded.slice(0, -1);
    map.pop();
  }
  return { folded, map };
}

/**
 * Where `quote` sits in `text`: exact first, then case- and
 * whitespace-insensitive. Offsets are into `text`; null when not found.
 */
export function locateQuote(text: string, quote: string): { start: number; end: number } | null {
  const q = quote.trim();
  if (q.length === 0) return null;
  const exact = text.indexOf(q);
  if (exact !== -1) return { start: exact, end: exact + q.length };

  const hay = foldWithMap(text);
  const needle = foldWithMap(q).folded;
  if (needle.length === 0) return null;
  const at = hay.folded.indexOf(needle);
  if (at === -1) return null;
  const start = hay.map[at];
  const end = hay.map[at + needle.length - 1] + 1;
  return { start, end };
}

function segmentEvidence(
  ctx: ExtractionContext,
  seg: SegmentAliasEntry,
  located: { start: number; end: number } | null,
): EvidenceDraft {
  return {
    source: 'segment',
    transcriptId: ctx.transcript!.id,
    segmentId: seg.segmentId,
    segmentRev: seg.rev,
    startMs: seg.startMs,
    endMs: seg.endMs,
    charStart: located ? located.start : null,
    charEnd: located ? located.end : null,
    quote: located
      ? seg.text.slice(located.start, located.end).slice(0, MAX_QUOTE_CHARS)
      : seg.text.slice(0, WHOLE_SEGMENT_QUOTE_CHARS),
  };
}

interface CiteOutcome {
  evidence: EvidenceDraft[];
  quoteNotLocated: boolean;
}

function resolveCites(ctx: ExtractionContext, cites: RawCite[]): CiteOutcome {
  const evidence: EvidenceDraft[] = [];
  const seen = new Set<string>();
  const contextText = offeredContextText(ctx.note.contextText);
  let quoteNotLocated = false;
  for (const cite of cites) {
    const source = cite.source.trim();
    let draft: EvidenceDraft;
    let key: string;
    if (source === CONTEXT_ALIAS) {
      if (contextText === null) continue; // `C` was never offered.
      const located = locateQuote(contextText, cite.quote);
      if (!located) continue; // A Context quote we cannot find is not evidence.
      draft = {
        source: 'note',
        noteId: ctx.note.id,
        noteVersion: ctx.note.version,
        charStart: null,
        charEnd: null,
        quote: contextText.slice(located.start, located.end).slice(0, MAX_QUOTE_CHARS),
      };
      key = `C:${located.start}:${located.end}`;
    } else if (source === SOURCE_ALIAS) {
      if (!ctx.source) continue; // `D` was never offered.
      const located = locateQuote(ctx.source.text, cite.quote);
      if (!located) continue; // A source quote we cannot find is not evidence.
      draft = {
        source: 'source_text',
        noteId: ctx.note.id,
        noteVersion: ctx.note.version,
        sourceObjectId: ctx.source.objectId,
        sourceTextLength: ctx.source.length,
        charStart: located.start,
        charEnd: located.end,
        quote: ctx.source.text.slice(located.start, located.end).slice(0, MAX_QUOTE_CHARS),
      };
      key = `D:${located.start}:${located.end}`;
    } else if (source === NOTE_ALIAS) {
      const located = locateQuote(ctx.note.body, cite.quote);
      if (!located) continue; // A note quote we cannot find is not evidence.
      draft = {
        source: 'note',
        noteId: ctx.note.id,
        noteVersion: ctx.note.version,
        charStart: located.start,
        charEnd: located.end,
        quote: ctx.note.body.slice(located.start, located.end).slice(0, MAX_QUOTE_CHARS),
      };
      key = `N:${located.start}:${located.end}`;
    } else {
      const seg = ctx.transcript ? ctx.segmentAlias.get(source) : undefined;
      if (!seg) continue; // An id the model was never handed.
      const located = locateQuote(seg.text, cite.quote);
      if (!located) quoteNotLocated = true;
      draft = segmentEvidence(ctx, seg, located);
      key = `S:${seg.segmentId}:${draft.charStart}:${draft.charEnd}`;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    evidence.push(draft);
  }
  return { evidence, quoteNotLocated };
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

/**
 * `YYYY-MM-DD` for a valid calendar date; `YYYY-MM` / `YYYY` are widened to
 * their first day (the precision field carries how exact it was). Anything
 * else is null.
 */
export function normalizeIsoDate(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  let y: number;
  let mo: number;
  let d: number;
  if (m) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  } else if ((m = /^(\d{4})-(\d{2})$/.exec(v))) {
    [y, mo, d] = [Number(m[1]), Number(m[2]), 1];
  } else if ((m = /^(\d{4})$/.exec(v))) {
    [y, mo, d] = [Number(m[1]), 1, 1];
  } else {
    return null;
  }
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) return null;
  return date.toISOString().slice(0, 10);
}

type Precision = 'day' | 'month' | 'year' | 'unknown';
const PRECISIONS: readonly Precision[] = ['day', 'month', 'year', 'unknown'];

function temporal(
  raw: { validFrom: string | null; validTo: string | null; precision: string | null },
  isTemporal: boolean,
): { validFrom: string | null; validTo: string | null; precision: Precision } | 'invalid' {
  if (!isTemporal) return { validFrom: null, validTo: null, precision: 'unknown' };
  let precision: Precision = PRECISIONS.includes(raw.precision as Precision) ? (raw.precision as Precision) : 'unknown';
  const validFrom = normalizeIsoDate(raw.validFrom);
  const validTo = normalizeIsoDate(raw.validTo);
  const fromBad = raw.validFrom !== null && raw.validFrom !== '' && validFrom === null;
  const toBad = raw.validTo !== null && raw.validTo !== '' && validTo === null;
  if (fromBad || toBad) precision = 'unknown';
  if (validFrom !== null && validTo !== null && validFrom > validTo) return 'invalid';
  return { validFrom, validTo, precision };
}

// -----------------------------------------------------------------------------
// Props
// -----------------------------------------------------------------------------

function validateExtractProps(
  schema: EffectiveSchema,
  typeKey: string,
  props: Record<string, unknown> | null,
  relation = false,
): Record<string, unknown> | null {
  const parsed = buildPropsSchema(schema, typeKey, { purpose: 'extract', relation }).safeParse(props ?? {});
  if (!parsed.success) return null;
  // `null` means "not stated" on the extract path: keep only stated values.
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

// -----------------------------------------------------------------------------
// The validator
// -----------------------------------------------------------------------------

function emptyStats(): ValidationStats {
  return {
    proposed: { entities: 0, relations: 0, items: 0 },
    dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 },
    quoteNotLocated: 0,
  };
}

const KNOWN_REF = /^k\d+$/;

function cleanAliases(label: string, aliases: string[]): string[] {
  const out: string[] = [];
  const seen = new Set([normalizeForMatch(label)]);
  for (const a of aliases) {
    const t = a.trim().slice(0, 200);
    const n = normalizeForMatch(t);
    if (t.length === 0 || n.length === 0 || seen.has(n)) continue;
    seen.add(n);
    out.push(t);
    if (out.length >= 10) break;
  }
  return out;
}

interface EntityInfo {
  type: string;
  survived: boolean;
}

/**
 * Validate one model answer against the context it was produced from.
 * Never throws.
 */
export function validateExtraction(raw: unknown, ctx: ExtractionContext): ValidationResult {
  const parsed = rawExtractionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errorClass: 'invalid_output',
      message: 'The model returned an answer that does not match the extraction format.',
    };
  }
  const answer = parsed.data;
  const stats = emptyStats();
  const rows: ProposedRow[] = [];

  const offeredEntity = new Map(ctx.offered.entityTypes.map((t) => [t.key, t]));
  const offeredItemByKind = new Map<string, EffectiveEntityType>(
    ctx.offered.itemTypes.map((t) => [t.itemKind as string, t]),
  );
  const offeredRelation = new Map(ctx.offered.relationTypes.map((r) => [r.type.key, r]));

  // --- entities ---------------------------------------------------------------
  const entityInfo = new Map<string, EntityInfo>();
  for (const e of answer.entities) {
    const ref = e.ref.trim();
    const out = validateEntity(ctx, e, ref, offeredEntity, entityInfo, stats);
    if (out) rows.push(out);
  }

  // Endpoint resolution: a known `k#`, the meeting, or an entity row's ref.
  const endpointOf = (
    value: string | null,
  ): { ref: EndpointRef; type: string; alive: boolean } | 'missing' | null => {
    if (value === null) return null;
    const v = value.trim();
    if (v.length === 0) return null;
    if (v === MEETING_REF) return { ref: { ref: MEETING_REF }, type: 'Meeting', alive: true };
    const info = entityInfo.get(v);
    if (info) {
      // A re-stated known entity is a proposal row of its own; endpoints
      // still point at the committed entity itself.
      const knownId = ctx.knownAlias.get(v);
      if (knownId) return { ref: { entityId: knownId }, type: ctx.knownById.get(knownId)!.type, alive: true };
      return { ref: { ref: v }, type: info.type, alive: info.survived };
    }
    const knownId = ctx.knownAlias.get(v);
    if (knownId) return { ref: { entityId: knownId }, type: ctx.knownById.get(knownId)!.type, alive: true };
    return 'missing';
  };

  // --- relations ----------------------------------------------------------------
  let r = 0;
  for (const rel of answer.relations) {
    const out = validateRelation(ctx, rel, `r${r + 1}`, offeredRelation, endpointOf, stats);
    if (out) {
      r += 1;
      rows.push(out);
    }
  }

  // --- items --------------------------------------------------------------------
  let i = 0;
  for (const item of answer.items) {
    const out = validateItem(ctx, item, `i${i + 1}`, offeredItemByKind, endpointOf, stats);
    if (out) {
      i += 1;
      rows.push(out);
    }
  }

  const topics = [...new Set(answer.meeting.topics.map((t) => t.trim()).filter((t) => t.length > 0))].slice(0, 50);
  return { ok: true, rows, topics, stats };
}

function validateEntity(
  ctx: ExtractionContext,
  e: RawEntity,
  ref: string,
  offered: Map<string, EffectiveEntityType>,
  info: Map<string, EntityInfo>,
  stats: ValidationStats,
): ProposedRow | null {
  const type = offered.get(e.type);
  const drop = (reason: keyof ValidationStats['dropped']): null => {
    stats.dropped[reason] += 1;
    return null;
  };
  // A second row claiming the same ref, or a ref shaped like one we reserve.
  if (ref.length === 0 || ref.length > 40 || ref === MEETING_REF || ref === DOCUMENT_REF || info.has(ref)) return drop('invalid');
  if (!type) {
    info.set(ref, { type: e.type, survived: false });
    return drop('unknownType');
  }
  info.set(ref, { type: type.key, survived: false });

  const knownId = KNOWN_REF.test(ref) ? ctx.knownAlias.get(ref) : undefined;
  if (KNOWN_REF.test(ref) && !knownId) return drop('invalid'); // claims an id it was never given

  const label = e.label.trim();
  if (label.length === 0 || label.length > 200) return drop('invalid');
  const props = validateExtractProps(ctx.effectiveSchema, type.key, e.props);
  if (props === null) return drop('invalid');

  const cites = resolveCites(ctx, e.evidence);
  if (cites.evidence.length === 0) return drop('uncited');

  const flags: ProposalItemFlag[] = [];
  if (cites.quoteNotLocated) {
    flags.push('quote_not_located');
    stats.quoteNotLocated += 1;
  }
  let resolution: ProposalResolution | null = null;
  if (knownId) {
    flags.push('model_claimed_match');
    if (ctx.knownById.get(knownId)!.type !== type.key) flags.push('type_changed');
    resolution = { ref: knownId, score: null, source: 'model', candidates: [], adjudication: null };
  }

  info.set(ref, { type: type.key, survived: true });
  stats.proposed.entities += 1;
  return {
    kind: 'entity',
    payload: {
      ref,
      type: type.key,
      label,
      aliases: cleanAliases(label, e.aliases),
      props,
      // A proposed Meeting's date is the one the source states (#780); the system Meeting gets the meeting date.
      occurredAt: type.key === 'Meeting' ? normalizeIsoDate(props.occurredOn as string | undefined) : null,
    },
    resolution,
    flags,
    evidence: cites.evidence,
  };
}

type EndpointLookup = (value: string | null) => { ref: EndpointRef; type: string; alive: boolean } | 'missing' | null;

function validateRelation(
  ctx: ExtractionContext,
  rel: RawRelation,
  ref: string,
  offered: Map<string, ExtractionContext['offered']['relationTypes'][number]>,
  endpointOf: EndpointLookup,
  stats: ValidationStats,
): ProposedRow | null {
  const drop = (reason: keyof ValidationStats['dropped']): null => {
    stats.dropped[reason] += 1;
    return null;
  };
  const type = offered.get(rel.type);
  if (!type) return drop('unknownType');

  const from = endpointOf(rel.from);
  const to = endpointOf(rel.to);
  if (from === 'missing' || to === 'missing') return drop('dangling');
  if (from === null || to === null) return drop('invalid');
  if (!type.from.includes(from.type) || !type.to.includes(to.type)) return drop('invalid');
  if (type.type.allowedPairs && !type.type.allowedPairs.some(([a, b]) => a === from.type && b === to.type)) {
    return drop('invalid');
  }
  if ('ref' in from.ref && 'ref' in to.ref && from.ref.ref === to.ref.ref) return drop('invalid');
  if ('entityId' in from.ref && 'entityId' in to.ref && from.ref.entityId === to.ref.entityId) return drop('invalid');

  const props = validateExtractProps(ctx.effectiveSchema, type.type.key, rel.props, true);
  if (props === null) return drop('invalid');
  const t = temporal(rel, type.type.temporal);
  if (t === 'invalid') return drop('invalid');

  const cites = resolveCites(ctx, rel.evidence);
  if (cites.evidence.length === 0) return drop('uncited');
  if (!from.alive || !to.alive) return drop('dangling');

  const flags: ProposalItemFlag[] = [];
  if (cites.quoteNotLocated) {
    flags.push('quote_not_located');
    stats.quoteNotLocated += 1;
  }
  stats.proposed.relations += 1;
  return {
    kind: 'relation',
    payload: { ref, type: type.type.key, from: from.ref, to: to.ref, props, ...t },
    resolution: null,
    flags,
    evidence: cites.evidence,
  };
}

const OWNER_TYPES = ['Person'];
const COUNTERPARTY_TYPES = ['Person', 'Organization'];

function validateItem(
  ctx: ExtractionContext,
  item: RawItem,
  ref: string,
  offered: Map<string, EffectiveEntityType>,
  endpointOf: EndpointLookup,
  stats: ValidationStats,
): ProposedRow | null {
  const drop = (reason: keyof ValidationStats['dropped']): null => {
    stats.dropped[reason] += 1;
    return null;
  };
  const type = offered.get(item.kind);
  if (!type) return drop('unknownType');
  const kind = item.kind as ItemPayloadKind;

  const subject = endpointOf(item.subject);
  const owner = kind === 'commitment' ? endpointOf(item.owner) : null;
  const counterparty = kind === 'commitment' ? endpointOf(item.counterparty) : null;
  if (subject === 'missing' || owner === 'missing' || counterparty === 'missing') return drop('dangling');

  if (subject === null && type.subjectRequired) return drop('invalid');
  if (subject !== null && !(type.subjectTypes ?? []).includes(subject.type)) return drop('invalid');
  if (kind === 'commitment' && owner === null) return drop('invalid');
  if (owner && !OWNER_TYPES.includes(owner.type)) return drop('invalid');
  if (counterparty && !COUNTERPARTY_TYPES.includes(counterparty.type)) return drop('invalid');

  const title = item.title.trim();
  const statement = item.statement.trim();
  if (title.length === 0 || title.length > 200 || statement.length === 0 || statement.length > 2000) {
    return drop('invalid');
  }
  let hash: string;
  try {
    hash = statementHash(kind, statement);
  } catch {
    return drop('invalid');
  }

  const props = validateExtractProps(ctx.effectiveSchema, type.key, item.props);
  if (props === null) return drop('invalid');
  const t = temporal(item, true);
  if (t === 'invalid') return drop('invalid');

  const cites = resolveCites(ctx, item.evidence);
  if (cites.evidence.length === 0) return drop('uncited');
  if ([subject, owner, counterparty].some((e) => e !== null && !e.alive)) return drop('dangling');

  const allowedStatuses = EXTRACTABLE_ITEM_STATUSES[kind] ?? [];
  const status =
    allowedStatuses.length === 0
      ? null
      : allowedStatuses.includes(item.status ?? '')
        ? (item.status as NonNullable<ItemPayload['status']>)
        : 'open';
  const sensitivity =
    kind === 'person_fact'
      ? (['business', 'personal', 'sensitive'] as const).find((s) => s === item.sensitivity) ?? type.sensitivityDefault
      : null;

  const flags: ProposalItemFlag[] = [];
  if (cites.quoteNotLocated) {
    flags.push('quote_not_located');
    stats.quoteNotLocated += 1;
  }
  if (sensitivity === 'sensitive') flags.push('sensitive');

  stats.proposed.items += 1;
  return {
    kind: 'item',
    payload: {
      ref,
      kind,
      title,
      statement,
      subject: subject ? subject.ref : null,
      owner: owner ? owner.ref : null,
      counterparty: counterparty ? counterparty.ref : null,
      meeting: kind === 'commitment' || kind === 'decision' ? { ref: MEETING_REF } : null,
      status,
      occurredAt: normalizeIsoDate(item.occurredAt),
      dueAt: kind === 'commitment' ? normalizeIsoDate(item.dueAt) : null,
      sensitivity,
      statementHash: hash,
      props,
      ...t,
    },
    resolution: null,
    flags,
    evidence: cites.evidence,
  };
}

// -----------------------------------------------------------------------------
// Deterministic rows
// -----------------------------------------------------------------------------

function wholeSegment(ctx: ExtractionContext, alias: string): EvidenceDraft | null {
  const seg = ctx.transcript ? ctx.segmentAlias.get(alias) : undefined;
  return seg ? segmentEvidence(ctx, seg, null) : null;
}

function meetingEvidence(ctx: ExtractionContext, rows: ProposedRow[]): EvidenceDraft | null {
  if (ctx.transcript !== null && ctx.segments.length > 0) {
    // The earliest line any surviving row cites, else the first line.
    const cited = new Set(
      rows.flatMap((row) => row.evidence.filter((e) => e.source === 'segment').map((e) => (e as { segmentId: string }).segmentId)),
    );
    const first = ctx.segments.find((s) => cited.has(s.segmentId)) ?? ctx.segments[0];
    return wholeSegment(ctx, first.alias);
  }
  const body = ctx.note.body;
  const located = locateQuote(body, ctx.note.title);
  if (located) {
    return {
      source: 'note',
      noteId: ctx.note.id,
      noteVersion: ctx.note.version,
      charStart: located.start,
      charEnd: located.end,
      quote: body.slice(located.start, located.end),
    };
  }
  // No title in the body: cite its first non-empty line.
  const match = /\S[^\n]*/.exec(body);
  if (!match) return null;
  const line = match[0].trimEnd().slice(0, WHOLE_SEGMENT_QUOTE_CHARS);
  return {
    source: 'note',
    noteId: ctx.note.id,
    noteVersion: ctx.note.version,
    charStart: match.index,
    charEnd: match.index + line.length,
    quote: line,
  };
}

type EntityRow = Extract<ProposedRow, { kind: 'entity' }>;

/** Where in the note body a row's first citation starts; null when it cites no located note text. */
function firstNoteOffset(row: ProposedRow): number | null {
  let first: number | null = null;
  for (const e of row.evidence) {
    if (e.source === 'source_text' && (first === null || e.charStart < first)) first = e.charStart;
  }
  // A run with a source document orders by the source text's offsets; a note's own offsets
  // are a different space, used only when a row cites no source text.
  if (first !== null) return first;
  for (const e of row.evidence) {
    if (e.source === 'note' && e.charStart !== null && (first === null || e.charStart < first)) first = e.charStart;
  }
  return first;
}

/** The Meetings the model proposed itself (a `k#` ref is a restated known entity, not a new meeting). */
function proposedMeetings(rows: ProposedRow[]): EntityRow[] {
  return rows.filter(
    (row): row is EntityRow => row.kind === 'entity' && row.payload.type === 'Meeting' && !KNOWN_REF.test(row.payload.ref),
  );
}

/** A copy of `row` with every endpoint passed through `fn`. */
function mapEndpoints(row: ProposedRow, fn: (ep: EndpointRef, row: ProposedRow) => EndpointRef): ProposedRow {
  const map = (ep: EndpointRef | null): EndpointRef | null => (ep === null ? null : fn(ep, row));
  if (row.kind === 'relation') {
    return { ...row, payload: { ...row.payload, from: map(row.payload.from)!, to: map(row.payload.to)! } };
  }
  if (row.kind === 'item') {
    const payload = row.payload;
    return {
      ...row,
      payload: {
        ...payload,
        subject: map(payload.subject),
        owner: map(payload.owner),
        counterparty: map(payload.counterparty),
        meeting: map(payload.meeting),
      },
    };
  }
  return row;
}

const isRef = (ep: EndpointRef, ref: string): boolean => 'ref' in ep && ep.ref === ref;

/**
 * Which proposed meeting a row that pointed at the system Meeting belongs to: the last meeting
 * whose first citation starts at or before the row's own, else the first. A record lists its
 * meetings in order, so "the most recent heading above the text it cites" is the meeting.
 */
function meetingFor(row: ProposedRow, meetings: EntityRow[]): string {
  const at = firstNoteOffset(row);
  const ordered = meetings
    .map((m) => ({ ref: m.payload.ref, at: firstNoteOffset(m) ?? Number.MAX_SAFE_INTEGER }))
    .sort((a, b) => a.at - b.at);
  if (at === null) return ordered[0].ref;
  let pick = ordered[0].ref;
  for (const m of ordered) if (m.at <= at) pick = m.ref;
  return pick;
}

/**
 * Prepend the Meeting row and append one ATTENDED per identified speaker. A
 * speaker's endpoint is the Person it is IDENTIFIED_AS, else a proposed
 * Person row carrying the speaker's name; a speaker with neither is skipped
 * (resolution may still link the name later). An ATTENDED the model already
 * proposed for the same person is kept instead of a second one.
 *
 * A document or record (#780, `ctx.documentOrigin`) differs in two ways:
 *
 * - THE MEETING RULE. When the model proposed TWO OR MORE new Meetings, those are the
 *   meetings and the system Meeting is not added: anything that pointed at `meeting` is
 *   re-pointed at the proposed meeting it was cited under. Fewer than two, and the system
 *   Meeting stays: a single proposed Meeting is folded into it (its endpoints re-pointed,
 *   its row dropped). A transcript never takes this path.
 * - THE DOCUMENT. One system Document row (the note's title, `preparedOn` when the date is
 *   stated), cited like the system Meeting, with RECORDED_IN from each meeting and
 *   PREPARED_FOR to `ctx.selfEntityId` when it is set.
 */
export function addDeterministicRows(
  ctx: ExtractionContext,
  result: Extract<ValidationResult, { ok: true }>,
): Extract<ValidationResult, { ok: true }> {
  let rows = [...result.rows];
  const stats: ValidationStats = JSON.parse(JSON.stringify(result.stats));
  const evidence = meetingEvidence(ctx, rows);
  const out: ProposedRow[] = [];

  // --- which meetings this note has ---------------------------------------------
  let useSystemMeeting = true;
  if (ctx.documentOrigin) {
    const proposed = proposedMeetings(rows);
    if (proposed.length >= 2) {
      useSystemMeeting = false;
      rows = rows.map((row) =>
        mapEndpoints(row, (ep, r) => (isRef(ep, MEETING_REF) ? { ref: meetingFor(r, proposed) } : ep)),
      );
      // The system-only attributes the model cannot state (`noteId` lets a re-run find them).
      rows = rows.map((row) => {
        if (row.kind !== 'entity' || !proposed.includes(row)) return row;
        const props: Record<string, unknown> = { ...row.payload.props, noteId: ctx.note.id };
        if (typeof props.occurredOn === 'string') props.dateSource = 'stated';
        return { ...row, payload: { ...row.payload, props } };
      });
    } else if (proposed.length === 1) {
      const only = proposed[0].payload.ref;
      rows = rows
        .filter((row) => row !== proposed[0])
        .map((row) => mapEndpoints(row, (ep) => (isRef(ep, only) ? { ref: MEETING_REF } : ep)));
      stats.proposed.entities -= 1;
    }
  }

  if (useSystemMeeting && evidence && ctx.effectiveSchema.entityType('Meeting')) {
    const props: Record<string, unknown> = { dateSource: ctx.dateSource, noteId: ctx.note.id };
    if (ctx.transcript) props.transcriptId = ctx.transcript.id;
    if (result.topics.length > 0) props.topics = result.topics;
    out.push({
      kind: 'entity',
      payload: {
        ref: MEETING_REF,
        type: 'Meeting',
        label: ctx.meetingTitle.slice(0, 200) || 'Meeting',
        aliases: [],
        props,
        occurredAt: ctx.meetingDate,
      },
      resolution: { ref: ctx.existingMeetingId, score: 1, source: 'meeting', candidates: [], adjudication: null },
      flags: [],
      evidence: [evidence],
    });
    stats.proposed.entities += 1;
  }

  // --- the Document (#780) --------------------------------------------------------
  const documentRows: ProposedRow[] = [];
  let n = rows.filter((row) => row.kind === 'relation').length;
  if (ctx.documentOrigin && evidence && ctx.effectiveSchema.entityType('Document')) {
    const props: Record<string, unknown> = { title: ctx.note.title.slice(0, 200) };
    if (ctx.dateSource === 'stated') props.preparedOn = ctx.meetingDate;
    documentRows.push({
      kind: 'entity',
      payload: {
        ref: DOCUMENT_REF,
        type: 'Document',
        label: ctx.note.title.slice(0, 200) || 'Document',
        aliases: [],
        props,
        occurredAt: null,
      },
      resolution: null,
      flags: [],
      evidence: [evidence],
    });
    stats.proposed.entities += 1;

    const link = (type: string, from: EndpointRef, to: EndpointRef, cite: EvidenceDraft[]) => {
      if (!ctx.effectiveSchema.relationType(type)) return;
      n += 1;
      documentRows.push({
        kind: 'relation',
        payload: { ref: `r${n}`, type, from, to, props: {}, validFrom: null, validTo: null, precision: 'unknown' },
        resolution: null,
        flags: [],
        evidence: cite,
      });
      stats.proposed.relations += 1;
    };
    if (useSystemMeeting) {
      link('RECORDED_IN', { ref: MEETING_REF }, { ref: DOCUMENT_REF }, [evidence]);
    } else {
      for (const m of proposedMeetings(rows)) {
        link('RECORDED_IN', { ref: m.payload.ref }, { ref: DOCUMENT_REF }, m.evidence.slice(0, 1));
      }
    }
    if (ctx.selfEntityId) link('PREPARED_FOR', { ref: DOCUMENT_REF }, { entityId: ctx.selfEntityId }, [evidence]);
  }
  out.push(...documentRows.filter((row) => row.kind === 'entity'));
  out.push(...rows);
  out.push(...documentRows.filter((row) => row.kind === 'relation'));

  const attended = ctx.offered.relationTypes.find((r) => r.type.key === 'ATTENDED');
  if (evidence && attended && ctx.transcript) {
    const endpointKey = (ref: EndpointRef) => ('entityId' in ref ? `id:${ref.entityId}` : `ref:${ref.ref}`);
    const already = new Set(
      rows
        .filter((row): row is Extract<ProposedRow, { kind: 'relation' }> => row.kind === 'relation' && row.payload.type === 'ATTENDED')
        .map((row) => endpointKey(row.payload.from)),
    );
    const personRows = rows.filter(
      (row): row is Extract<ProposedRow, { kind: 'entity' }> => row.kind === 'entity' && row.payload.type === 'Person',
    );
    for (const speaker of ctx.speakers) {
      if (!speaker.name || !speaker.firstSegmentAlias) continue;
      let from: EndpointRef | null = null;
      if (speaker.personEntityId) {
        from = { entityId: speaker.personEntityId };
      } else {
        const name = normalizeForMatch(speaker.name);
        const match = personRows.find(
          (row) =>
            normalizeForMatch(row.payload.label) === name ||
            row.payload.aliases.some((a) => normalizeForMatch(a) === name),
        );
        if (match) from = match.resolution?.ref ? { entityId: match.resolution.ref } : { ref: match.payload.ref };
      }
      if (!from || already.has(endpointKey(from))) continue;
      const cite = wholeSegment(ctx, speaker.firstSegmentAlias);
      if (!cite) continue;
      already.add(endpointKey(from));
      n += 1;
      out.push({
        kind: 'relation',
        payload: {
          ref: `r${n}`,
          type: 'ATTENDED',
          from,
          to: { ref: MEETING_REF },
          props: {},
          validFrom: null,
          validTo: null,
          precision: 'unknown',
        },
        resolution: null,
        flags: [],
        evidence: [cite],
      });
      stats.proposed.relations += 1;
    }
  }

  return { ok: true, rows: out, topics: result.topics, stats };
}
