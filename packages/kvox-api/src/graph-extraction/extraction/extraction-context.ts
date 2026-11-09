// =============================================================================
// buildExtractionContext (#363, epic #346; docs/specs/ontology.md §6, §17, §19)
// =============================================================================
//
// PURE: no Prisma, no Nest, no clock, no randomness. `ExtractionInputLoader` is
// the only database reader; it loads everything ONCE into an
// `ExtractionInput`, and this function turns that snapshot into what the
// prompt, the output schema and the validator all read:
//
//   - SHORT ALIASES. Segments become `s1…sN` in ordinal order, known entities
//     `k1…kM`, the note is `N`, and the note's Context field — when it is not
//     blank — is `C` (#440). The model cites ids it was handed; an id it
//     invents is structurally detectable (not in the map) rather than a
//     plausible-looking UUID.
//   - THE OFFERED SCHEMA. The caller's effective schema, narrowed to what
//     extraction may propose: extractable, non-deprecated types; only
//     extractable, non-deprecated attributes; guidance's `entityTypes` /
//     `relationTypes` applied. Nothing outside it reaches the prompt or the
//     output schema (§17.1's "closed by default", applied to proposing).
//   - THE KNOWN-ENTITIES LIST (§6), max 60, in priority order, deduplicated:
//     pinned → persons IDENTIFIED_AS this transcript's speakers → their
//     WORKS_FOR organizations → entities named (whole-word, normalized) in the
//     Context text → the most-mentioned entities of the last 90 days. Only
//     live rows (`accepted`/`edited`, not merged) of a type the effective
//     schema still has. Labels and aliases only — never a fact about anyone.
//   - THE MEETING DATE every relative date resolves against (§5.4).
//
// Deviation from the issue text: the input carries the known-entity CANDIDATES
// per priority bucket (`knownEntityCandidates`) rather than one pre-merged
// list, so the priority order, the cap, the dedup and the liveness filter are
// all pure and tested here rather than split across a query.
// =============================================================================

import { localDateKey } from '../../core/index.js';
import type {
  EffectiveAttribute,
  EffectiveEntityType,
  EffectiveRelationType,
  EffectiveSchema,
} from '@marinoscar/kvox-contract/ontology';

import type { UserGuidance } from './dto/extraction.dto.js';

/** The most known entities one prompt carries (§6). */
export const MAX_KNOWN_ENTITIES = 60;

/** The alias of the note itself in a citation. */
export const NOTE_ALIAS = 'N';

/**
 * The alias of the note's Context field in a citation (#440). Offered only
 * when the Context is non-blank (`offeredContextText`). A `C` citation is
 * stored as a note citation with NULL `charStart`/`charEnd` — the
 * `kg_evidence` convention for "the note's Context field".
 */
export const CONTEXT_ALIAS = 'C';

/**
 * The Context text the model is shown and may cite as `C`, trimmed; null when
 * there is none or it is blank (the section and the alias are then omitted).
 */
export function offeredContextText(contextText: string | null | undefined): string | null {
  const trimmed = contextText?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The alias of the source document's full text in a citation (#789). Offered only
 * when the note was generated from a document whose extracted text is stored
 * (`ExtractionInput.sourceText`). A `D` citation is stored as a source-text
 * citation: `source_object_id` plus offsets into that text.
 */
export const SOURCE_ALIAS = 'D';

/** The ref of the deterministic Meeting row, and the endpoint the model uses for it. */
export const MEETING_REF = 'meeting';

/** The ref of the deterministic Document row a document-origin note gets (#780). */
export const DOCUMENT_REF = 'document';

/** What a note was made from: `NoteSourceType`, as far as extraction cares. */
export type ExtractionSourceType = 'transcript' | 'note' | 'document';

/** Review statuses a known entity may carry to be offered. */
const LIVE_REVIEW_STATUSES = new Set(['accepted', 'edited']);

export interface KnownEntityRow {
  id: string;
  type: string;
  label: string;
  aliases: string[];
  reviewStatus: string;
  mergedIntoId: string | null;
  /** A Person's WORKS_FOR organization label, when the loader found one. */
  orgLabel?: string | null;
}

export interface ExtractionInput {
  note: {
    id: string;
    title: string;
    bodyAtVersion: string;
    version: number;
    contextText: string | null;
    createdAt: Date;
  };
  /**
   * The full text a note was GENERATED FROM, for a note made from a document (#789):
   * the stored extracted-text object and its text. When present the extraction reads
   * this text (chunked, #777) and the generated note is shown as context; a citation
   * of the text is anchored to `objectId`. Absent or null (a transcript note, an
   * imported note whose body already is the document, a source that was purged):
   * the note body is the extraction input, as before.
   */
  sourceText?: { objectId: string; text: string } | null;
  /** `NoteOriginService.resolve()`; null = a note-only meeting. */
  transcript: { id: string; title: string; recordedAt: Date; createdAt: Date } | null;
  /** Compact, ordinal order, no words. */
  segments: Array<{ id: string; rev: number; startMs: number; endMs: number; speakerId: string; text: string }>;
  /**
   * `displayName` is null for an unidentified speaker (still on its
   * placeholder); `personEntityId` is the Person it is IDENTIFIED_AS (#356).
   */
  speakers: Array<{ id: string; label: string | null; displayName: string | null; personEntityId: string | null }>;
  effectiveSchema: EffectiveSchema;
  guidance: UserGuidance | null;
  /**
   * Opt-in system-created types this run may propose (see `OfferedSchemaOptions`).
   * Absent or empty keeps today's behaviour: the Meeting is created by the system only.
   */
  proposeTypes?: readonly string[];
  /**
   * What the note was made from. `'document'` (an uploaded document or record, no
   * transcript behind it) turns on Meeting proposals and adds the system Document
   * row (#780). Absent or any other value keeps today's behaviour.
   */
  sourceType?: ExtractionSourceType;
  /**
   * The owner's own Person entity id when no resolved `self` row is given (evaluation
   * fixtures set it directly). `self` wins when present. The resolved id is the target of
   * the Document's PREPARED_FOR edge (#780); absent or null: no such edge.
   */
  selfEntityId?: string | null;
  /**
   * The Person the note's owner chose as themselves (`preferences.self.entityId`, resolved by
   * `GraphSelfService`: live, merges followed), or null/absent. When present it leads the known
   * entities, so it always has a `k#` the model can cite, and the prompt gains a `# You` section.
   */
  self?: KnownEntityRow | null;
  knownEntityCandidates: {
    pinned: KnownEntityRow[];
    speakerPersons: KnownEntityRow[];
    organizations: KnownEntityRow[];
    /** A bounded pool the Context text is matched against. */
    contextPool: KnownEntityRow[];
    /** Most mentioned first (last 90 days). */
    recentlyMentioned: KnownEntityRow[];
  };
  /** The Meeting whose `props.transcriptId`/`noteId` matches. */
  existingMeeting: { id: string } | null;
  /**
   * The note owner's IANA time zone (absent: UTC). The meeting date is the day the recording
   * (or the note) falls on IN THIS ZONE: a call recorded at 21:30 in Chicago on the 26th is the
   * 26th, not the 27th it is in UTC.
   */
  timeZone?: string;
}

export interface SegmentAliasEntry {
  segmentId: string;
  rev: number;
  startMs: number;
  endMs: number;
  speakerId: string;
  text: string;
}

export interface SegmentLine extends SegmentAliasEntry {
  alias: string;
  speakerName: string;
}

export interface KnownEntityEntry {
  alias: string;
  id: string;
  type: string;
  label: string;
  aliases: string[];
  orgLabel: string | null;
}

export interface SpeakerLine {
  id: string;
  label: string | null;
  /** Null = unidentified. */
  name: string | null;
  personEntityId: string | null;
  /** The `k#` of the Person this speaker is identified as, when offered. */
  knownAlias: string | null;
  /** The speaker's first line, for the deterministic ATTENDED evidence. */
  firstSegmentAlias: string | null;
}

export interface OfferedRelationType {
  type: EffectiveRelationType;
  /** Endpoint types after narrowing to offered entity types (+ Meeting). */
  from: string[];
  to: string[];
}

export interface OfferedSchema {
  /** Types stored in `kg_entities` the model may propose (never Meeting). */
  entityTypes: EffectiveEntityType[];
  /** Types stored in `kg_items` the model may propose. */
  itemTypes: EffectiveEntityType[];
  relationTypes: OfferedRelationType[];
}

export type DateSource = 'stated' | 'note_created_at';

export interface ExtractionContext {
  note: { id: string; title: string; body: string; version: number; contextText: string | null };
  /**
   * The source document's text this call reads (#789), or null. In a chunked run
   * `text` is the CHUNK's text (`chunkContext`) while `length` stays the whole
   * text's length, because a citation's offsets are absolute in the whole text.
   */
  source: { objectId: string; text: string; length: number } | null;
  transcript: { id: string; title: string } | null;
  meetingTitle: string;
  /** `YYYY-MM-DD`, the day of the recording (or the note) in the owner's zone; stored as a floating date. */
  meetingDate: string;
  dateSource: DateSource;
  segments: SegmentLine[];
  segmentAlias: Map<string, SegmentAliasEntry>;
  knownEntities: KnownEntityEntry[];
  /** The note owner's own node as a known entity (#778), or null when none is chosen. */
  self: KnownEntityEntry | null;
  /** `k3` → entity id. */
  knownAlias: Map<string, string>;
  /** entity id → its entry. */
  knownById: Map<string, KnownEntityEntry>;
  speakers: SpeakerLine[];
  effectiveSchema: EffectiveSchema;
  offered: OfferedSchema;
  /** Only when the reviewer pinned something or wrote instructions. */
  guidance: { pinnedAliases: string[]; instructions: string } | null;
  existingMeetingId: string | null;
  /**
   * A document or record with no transcript behind it (#780): extraction may propose
   * Meetings, and the system adds one Document row. False for every transcript.
   */
  documentOrigin: boolean;
  /** The owner's own Person entity id (#778), or null. Only PREPARED_FOR reads it. */
  selfEntityId: string | null;
}

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

/** Lowercase, NFKC, every run of non-letter/digit collapsed to one space. */
export function normalizeForMatch(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** `YYYY-MM-DD` in UTC. */
export function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const DATE_PATTERNS = [
  /\b\d{4}-\d{2}-\d{2}\b/,
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/,
  new RegExp(`\\b${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?\\b`, 'i'),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}\\b`, 'i'),
];

/** Whether free text names a calendar date. */
export function namesADate(text: string | null): boolean {
  if (!text) return false;
  return DATE_PATTERNS.some((re) => re.test(text));
}

/**
 * A recording date counts as STATED once somebody moved it off the upload
 * instant (#352 stamps `recordedAt` with the same `Date` as `createdAt`, so a
 * difference means a person corrected it).
 */
const RECORDED_AT_EDIT_TOLERANCE_MS = 60_000;

function isExtractAttribute(attr: EffectiveAttribute): boolean {
  return attr.extractable && !attr.deprecated;
}

/** The attributes the model is asked for on one type. */
export function offeredAttributes(attrs: readonly EffectiveAttribute[]): EffectiveAttribute[] {
  return attrs.filter(isExtractAttribute);
}

// -----------------------------------------------------------------------------
// The offered schema
// -----------------------------------------------------------------------------

/**
 * What `buildOfferedSchema` may offer beyond the default. Empty by default, so
 * every current caller is unchanged.
 */
export interface OfferedSchemaOptions {
  /**
   * Entity types that are system-created by default (`extractable: false`, today
   * only `Meeting`) but that this run may propose. The host opts in for a source
   * that records several meetings (#776, #780); the type must still exist in the
   * effective schema, be non-deprecated and pass guidance. Items and unknown
   * keys are ignored.
   */
  proposeTypes?: readonly string[];
}

/** The system-created types a host may opt in to proposing. */
export const OPT_IN_PROPOSABLE_TYPES: readonly string[] = ['Meeting'];

export function buildOfferedSchema(
  schema: EffectiveSchema,
  guidance: UserGuidance | null,
  options: OfferedSchemaOptions = {},
): OfferedSchema {
  const typeFilter = guidance?.entityTypes ? new Set(guidance.entityTypes) : null;
  const relationFilter = guidance?.relationTypes ? new Set(guidance.relationTypes) : null;
  const optedIn = new Set((options.proposeTypes ?? []).filter((k) => OPT_IN_PROPOSABLE_TYPES.includes(k)));

  const proposable = schema.entityTypes.filter(
    (t) =>
      (t.extractable || (optedIn.has(t.key) && t.storage === 'entity')) &&
      !t.deprecated &&
      (typeFilter === null || typeFilter.has(t.key)),
  );
  const entityTypes = proposable.filter((t) => t.storage === 'entity');
  const itemTypes = proposable.filter((t) => t.storage === 'item');

  const endpointTypes = new Set(entityTypes.map((t) => t.key));
  // The meeting itself is always addressable (`"meeting"`), though never proposed.
  if (schema.entityType('Meeting')) endpointTypes.add('Meeting');

  const relationTypes: OfferedRelationType[] = [];
  for (const r of schema.relationTypes) {
    if (r.representation.kind !== 'edge' || !r.extractable || r.deprecated) continue;
    if (relationFilter !== null && !relationFilter.has(r.key)) continue;
    let from = r.from.filter((k) => endpointTypes.has(k));
    let to = r.to.filter((k) => endpointTypes.has(k));
    if (r.allowedPairs) {
      const pairs = r.allowedPairs.filter(([a, b]) => from.includes(a) && to.includes(b));
      from = from.filter((f) => pairs.some(([a]) => a === f));
      to = to.filter((t) => pairs.some(([, b]) => b === t));
    }
    // A relation whose only endpoints are the meeting on both sides is not proposable.
    if (from.length === 0 || to.length === 0) continue;
    if (from.every((f) => f === 'Meeting') && to.every((t) => t === 'Meeting')) continue;
    relationTypes.push({ type: r, from, to });
  }

  return { entityTypes, itemTypes, relationTypes };
}

// -----------------------------------------------------------------------------
// Known entities
// -----------------------------------------------------------------------------

function mentionedIn(normalizedContext: string, row: KnownEntityRow): boolean {
  const haystack = ` ${normalizedContext} `;
  return [row.label, ...row.aliases].some((name) => {
    const needle = normalizeForMatch(name);
    return needle.length > 0 && haystack.includes(` ${needle} `);
  });
}

export function selectKnownEntities(input: ExtractionInput): KnownEntityRow[] {
  const { pinned, speakerPersons, organizations, contextPool, recentlyMentioned } = input.knownEntityCandidates;
  const ctx = normalizeForMatch(input.note.contextText ?? '');
  const fromContext = ctx.length > 0 ? contextPool.filter((row) => mentionedIn(ctx, row)) : [];

  const out: KnownEntityRow[] = [];
  const seen = new Set<string>();
  // The owner's own node leads (#778): it is always offered, so a `# You` section can name its `k#`.
  const self = input.self ? [input.self] : [];
  for (const bucket of [self, pinned, speakerPersons, organizations, fromContext, recentlyMentioned]) {
    for (const row of bucket) {
      if (out.length >= MAX_KNOWN_ENTITIES) return out;
      if (seen.has(row.id)) continue;
      if (!LIVE_REVIEW_STATUSES.has(row.reviewStatus) || row.mergedIntoId !== null) continue;
      if (!input.effectiveSchema.entityType(row.type)) continue;
      seen.add(row.id);
      out.push(row);
    }
  }
  return out;
}

// -----------------------------------------------------------------------------
// The builder
// -----------------------------------------------------------------------------

function speakerDisplay(speaker: ExtractionInput['speakers'][number]): string {
  if (speaker.displayName) return speaker.displayName;
  return speaker.label ? `Speaker ${speaker.label}` : 'Unknown speaker';
}

export function buildExtractionContext(input: ExtractionInput): ExtractionContext {
  // Segments, in the order the loader gave them (ordinal).
  const speakerById = new Map(input.speakers.map((s) => [s.id, s]));
  const segments: SegmentLine[] = input.segments.map((seg, i) => {
    const speaker = speakerById.get(seg.speakerId);
    return {
      alias: `s${i + 1}`,
      segmentId: seg.id,
      rev: seg.rev,
      startMs: seg.startMs,
      endMs: seg.endMs,
      speakerId: seg.speakerId,
      text: seg.text,
      speakerName: speaker ? speakerDisplay(speaker) : 'Unknown speaker',
    };
  });
  const segmentAlias = new Map<string, SegmentAliasEntry>(
    segments.map(({ alias, speakerName: _n, ...entry }) => [alias, entry]),
  );

  // Known entities.
  const knownEntities: KnownEntityEntry[] = selectKnownEntities(input).map((row, i) => ({
    alias: `k${i + 1}`,
    id: row.id,
    type: row.type,
    label: row.label,
    aliases: [...new Set(row.aliases.filter((a) => a !== row.label))],
    orgLabel: row.orgLabel ?? null,
  }));
  const knownAlias = new Map(knownEntities.map((k) => [k.alias, k.id]));
  const knownById = new Map(knownEntities.map((k) => [k.id, k]));
  const self = input.self ? (knownById.get(input.self.id) ?? null) : null;

  // Speakers.
  const speakers: SpeakerLine[] = input.speakers.map((s) => ({
    id: s.id,
    label: s.label,
    name: s.displayName,
    personEntityId: s.personEntityId,
    knownAlias: s.personEntityId ? (knownById.get(s.personEntityId)?.alias ?? null) : null,
    firstSegmentAlias: segments.find((seg) => seg.speakerId === s.id)?.alias ?? null,
  }));

  // Meeting date.
  const recordedAt = input.transcript?.recordedAt ?? null;
  const meetingDate = localDateKey(recordedAt ?? input.note.createdAt, input.timeZone ?? 'UTC');
  const recordedAtEdited =
    input.transcript !== null &&
    Math.abs(input.transcript.recordedAt.getTime() - input.transcript.createdAt.getTime()) >
      RECORDED_AT_EDIT_TOLERANCE_MS;
  const dateSource: DateSource =
    recordedAtEdited || namesADate(input.note.contextText) ? 'stated' : 'note_created_at';

  // A document or record (no transcript) may hold several meetings (#780).
  const documentOrigin = input.sourceType === 'document' && input.transcript === null;

  // Guidance.
  const pinnedAliases = (input.guidance?.pinnedEntityIds ?? [])
    .map((id) => knownById.get(id)?.alias)
    .filter((a): a is string => a !== undefined);
  const instructions = input.guidance?.instructions?.trim() ?? '';
  const guidance =
    pinnedAliases.length > 0 || instructions.length > 0 ? { pinnedAliases, instructions } : null;

  return {
    note: {
      id: input.note.id,
      title: input.note.title,
      body: input.note.bodyAtVersion,
      version: input.note.version,
      contextText: input.note.contextText,
    },
    source:
      input.sourceText && input.sourceText.text.trim().length > 0
        ? { objectId: input.sourceText.objectId, text: input.sourceText.text, length: input.sourceText.text.length }
        : null,
    transcript: input.transcript ? { id: input.transcript.id, title: input.transcript.title } : null,
    meetingTitle: (input.transcript?.title ?? input.note.title).trim() || input.note.title,
    meetingDate,
    dateSource,
    segments,
    segmentAlias,
    knownEntities,
    self,
    knownAlias,
    knownById,
    speakers,
    effectiveSchema: input.effectiveSchema,
    offered: buildOfferedSchema(input.effectiveSchema, input.guidance, {
      proposeTypes: documentOrigin ? [...(input.proposeTypes ?? []), 'Meeting'] : input.proposeTypes,
    }),
    guidance,
    existingMeetingId: input.existingMeeting?.id ?? null,
    documentOrigin,
    selfEntityId: input.self?.id ?? input.selfEntityId ?? null,
  };
}
