/**
 * The knowledge-graph client — epic #347 (read side: #373), epic #344/#346
 * (ontology, edit, forget).
 *
 * ONE EXPORTED FUNCTION PER ENDPOINT, and every response shape is a TS
 * interface MIRRORING the API's Zod schema field for field:
 *
 *   - #370 `apps/api/src/graph/read/dto/graph-read.dto.ts` — entity index,
 *     detail, neighbourhood, timeline, mentions, evidence links.
 *   - #372 `apps/api/src/graph/brief/dto/entity-brief.dto.ts` — the brief.
 *   - #354 `GET /api/graph/ontology` — `EffectiveSchemaPayload`, IMPORTED from
 *     `@app/shared/ontology` rather than re-declared, so a drift fails `tsc`.
 *   - #355 `PATCH /api/graph/entities/:id` and #357 `POST …/forget`.
 *   - #355 `/api/graph/attribute-defs[/:id]` — the caller's own attribute
 *     definitions (#369's Knowledge graph settings card). `kind`,
 *     `entityType` and `key` are immutable; a "delete" deprecates (§17.3).
 *
 * A field renamed on the API must be renamed here and in
 * `__tests__/mocks/graphData.ts` in the same PR — the fixtures are typed by
 * these interfaces, so a stale fixture is a type error rather than a test
 * that passes against a shape the server no longer sends.
 *
 * ⚠ `#367` (the proposal review sheet) appends its own proposal functions to
 * this file. Keep the sections separate so the two diffs merge cleanly.
 */

import type {
  AttributeKind,
  EffectiveAttributePayload,
  EffectiveEntityTypePayload,
  EffectiveRelationTypePayload,
  EffectiveSchemaPayload,
  Sensitivity,
} from '@app/shared/ontology';

import { api, ApiError } from './api';

// =============================================================================
// Ontology (#354) — the payload every graph form is generated from
// =============================================================================

export type GraphOntology = EffectiveSchemaPayload;
export type GraphAttributeDef = EffectiveAttributePayload;
export type GraphEntityTypeDef = EffectiveEntityTypePayload;
export type GraphRelationTypeDef = EffectiveRelationTypePayload;
/** #369's names for the same payload's parts (the settings card uses these). */
export type GraphEntityType = EffectiveSchemaPayload['entityTypes'][number];
export type GraphAttribute = GraphEntityType['attributes'][number];
export type GraphDomain = EffectiveSchemaPayload['domains'][number];

export type { AttributeKind, Sensitivity };

export function getGraphOntology(signal?: AbortSignal): Promise<GraphOntology> {
  return api.get<GraphOntology>('/graph/ontology', { signal });
}

// =============================================================================
// Shared value types
// =============================================================================

export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';
export type GraphItemKind = 'commitment' | 'decision' | 'claim' | 'person_fact';

/** `entityRef` in both #370 and #372. */
export interface GraphEntityRef {
  id: string;
  label: string;
  type: string;
}

// =============================================================================
// Entity index + detail (#370)
// =============================================================================

export interface GraphEntitySummary {
  id: string;
  type: string;
  label: string;
  /** At most five. */
  aliases: string[];
  mentionCount: number;
  /** Max `occurred_at` of Meetings this entity has evidence in. */
  lastSeenAt: string | null;
  /** Present only with `?transcriptId`. */
  speakerIds?: string[];
}

export interface GraphEntityListParams {
  type?: readonly string[];
  q?: string;
  transcriptId?: string;
  sort?: 'updated' | 'viewed';
  cursor?: string;
  limit?: number;
}

export interface GraphEntityListResponse {
  items: GraphEntitySummary[];
  /** Always `null` when `q` is set (top-`limit` by similarity). */
  nextCursor: string | null;
}

export type GraphAliasSource = 'user' | 'extraction' | 'speaker_naming' | 'import';

export interface GraphEntityAlias {
  id: string;
  alias: string;
  source: GraphAliasSource;
}

export interface GraphEntityCounts {
  relations: number;
  mentions: number;
  evidence: number;
  items: {
    commitment: number;
    decision: number;
    claim: number;
    person_fact: number;
  };
  openCommitments: number;
}

export interface GraphEntityDetail {
  id: string;
  type: string;
  label: string;
  props: Record<string, unknown>;
  aliases: GraphEntityAlias[];
  /** Meeting only. */
  occurredAt: string | null;
  reviewStatus: 'accepted' | 'edited';
  ontologyVersion: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  counts: GraphEntityCounts;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Graph slice (#370) — neighbourhood + expand
// =============================================================================

export interface GraphNode {
  id: string;
  nodeKind: 'entity' | 'item';
  /** Entity type key, or item kind. */
  type: string;
  label: string;
  depth: number;
  degree: number;
  /** Item status; null for entities. */
  status: string | null;
  occurredAt: string | null;
}

export interface GraphValidRange {
  from: string | null;
  to: string | null;
  precision: DatePrecision;
}

export interface GraphEdge {
  /** `kg_relations.id`, or `virt:<itemId>:<TYPE>` for column-derived edges. */
  id: string;
  type: string;
  /** Stored direction, never inverted. */
  source: string;
  target: string;
  valid: GraphValidRange | null;
  confidence: number | null;
  virtual: boolean;
}

export interface GraphSlice {
  seedIds: string[];
  asOf: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  cap: number;
}

export interface GraphNeighborhoodParams {
  hops?: 1 | 2;
  types?: readonly string[];
  relationTypes?: readonly string[];
  asOf?: string;
  limit?: number;
}

// =============================================================================
// Timeline + mentions (#370)
// =============================================================================

export interface TimelineItem {
  id: string;
  kind: GraphItemKind;
  title: string | null;
  statement: string;
  status: string | null;
  dueAt: string | null;
  ownerPerson: GraphEntityRef | null;
  counterparty: GraphEntityRef | null;
  sensitivity: 'business' | 'personal' | 'sensitive' | null;
  superseded: boolean;
  supersededById: string | null;
}

export interface TimelineRelation {
  id: string;
  type: string;
  direction: 'out' | 'in';
  other: GraphEntityRef;
  valid: GraphValidRange | null;
}

export interface TimelineEvent {
  /** Item id, `rel:<id>:start|end`, or meeting id. */
  id: string;
  eventKind: 'item' | 'relation_started' | 'relation_ended' | 'meeting';
  at: string | null;
  precision: DatePrecision;
  item?: TimelineItem;
  relation?: TimelineRelation;
  meeting?: GraphEntityRef;
  /** At most five. */
  evidenceIds: string[];
  evidenceCount: number;
}

export interface TimelineParams {
  asOf?: string;
  kinds?: readonly string[];
  includeSensitive?: boolean;
  cursor?: string;
  limit?: number;
}

export interface TimelineResponse {
  items: TimelineEvent[];
  nextCursor: string | null;
  asOf: string;
}

export interface EntityMention {
  kind: 'note' | 'transcript';
  id: string;
  title: string | null;
  occurredAt: string | null;
  available: boolean;
}

export interface EntityMentionsResponse {
  items: EntityMention[];
  nextCursor: string | null;
}

// =============================================================================
// Evidence links (#370)
// =============================================================================

export interface SegmentEvidenceSource {
  kind: 'segment';
  transcriptId: string | null;
  transcriptTitle: string | null;
  segmentId: string | null;
  segmentRev: number | null;
  currentSegmentRev: number | null;
  startMs: number | null;
  endMs: number | null;
  textChanged: boolean;
  available: boolean;
  href: string | null;
}

export interface NoteEvidenceSource {
  kind: 'note';
  noteId: string | null;
  noteTitle: string | null;
  noteVersion: number | null;
  currentNoteVersion: number | null;
  charStart: number | null;
  charEnd: number | null;
  versionChanged: boolean;
  available: boolean;
  href: string | null;
}

export interface ImportEvidenceSource {
  kind: 'import';
  importObjectId: string | null;
  sourceIri: string | null;
  available: boolean;
  href: null;
}

export type EvidenceSource = SegmentEvidenceSource | NoteEvidenceSource | ImportEvidenceSource;

export interface EvidenceLink {
  id: string;
  subjectKind: 'entity' | 'relation' | 'item' | 'proposal_item' | 'import';
  subjectId: string;
  /** Rendered as TEXT, never HTML. */
  quote: string;
  createdAt: string;
  source: EvidenceSource;
}

/** The API's cap on one `GET /api/graph/evidence?ids=` call. */
export const EVIDENCE_BATCH_MAX = 50;

// =============================================================================
// Brief (#372)
// =============================================================================

export interface CitedStatement {
  text: string;
  /** One to eight. */
  evidenceIds: string[];
}

export interface BriefEntry {
  itemId: string;
  kind: GraphItemKind;
  title: string | null;
  statement: string;
  occurredAt: string | null;
  precision: DatePrecision;
  status: string | null;
  dueAt: string | null;
  ownerPerson: GraphEntityRef | null;
  counterparty: GraphEntityRef | null;
  superseded: boolean;
  evidenceIds: string[];
}

export interface PeopleChange {
  relationId: string;
  type: string;
  change: 'started' | 'ended';
  at: string;
  precision: DatePrecision;
  person: GraphEntityRef;
  other: GraphEntityRef;
  /** `HAS_ROLE` props.title. */
  title: string | null;
  evidenceIds: string[];
}

export interface RelatedSource {
  kind: 'transcript' | 'note';
  id: string;
  title: string;
  /** Already HTML-escaped with `<mark>` — render ONLY through `SearchSnippet`. */
  snippetHtml: string | null;
  startMs: number | null;
  score: number;
  inGraph: boolean;
  occurredAt: string | null;
}

export type DigestUnavailableReason =
  | 'graph_disabled'
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'model_lacks_capability';

export interface EntityDigest {
  statements: CitedStatement[];
  coversUntil: string | null;
  generatedAt: string;
  model: string;
}

export interface EntityBrief {
  entity: GraphEntityRef;
  window: {
    since: string | null;
    sinceSource: 'query' | 'last_viewed' | 'digest' | 'default';
    asOf: string;
    lastViewedAt: string | null;
  };
  digest: EntityDigest | null;
  digestStale: boolean;
  digestPending: boolean;
  digestUnavailable: DigestUnavailableReason | null;
  sections: {
    whatChanged: BriefEntry[];
    decisions: BriefEntry[];
    openCommitments: { theirs: BriefEntry[]; yours: BriefEntry[] };
    risksClaims: BriefEntry[];
    peopleChanges: PeopleChange[];
  };
  related: RelatedSource[];
}

export interface EntityBriefParams {
  since?: string;
  asOf?: string;
  markViewed?: boolean;
}

// =============================================================================
// Writes (#355, #357)
// =============================================================================

/** #355's request shape. `type` is deliberately absent — a type changes only through a proposal. */
export interface GraphEntityPatch {
  label?: string;
  /** Merge: `key → value` sets, `key → null` clears, absent keys unchanged. */
  props?: Record<string, unknown>;
  addAliases?: string[];
  removeAliasIds?: string[];
}

/** #355's response projection (`graphEntitySchema`), which is NOT the #370 detail. */
export interface GraphEntityRecord {
  id: string;
  type: string;
  label: string;
  props: Record<string, unknown>;
  reviewStatus: string;
  mergedIntoId: string | null;
  occurredAt: string | null;
  ontologyVersion: string;
  aliases: Array<GraphEntityAlias & { normalized: string; createdAt: string }>;
  createdAt: string;
  updatedAt: string;
}

export const FORGET_CONFIRMATION = 'FORGET';

export interface ForgetEntityResponse {
  jobId: string;
  entityId: string;
  status: 'pending' | 'running';
}

// =============================================================================
// Query-string helper
// =============================================================================

type QueryValue = string | number | boolean | readonly string[] | undefined | null;

/** Build `?a=1&b=x,y`, dropping empty values. Arrays are comma-joined (the API's `csv`). */
export function buildGraphQuery(params: Record<string, QueryValue>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      search.set(key, value.join(','));
    } else {
      search.set(key, String(value));
    }
  }
  const qs = search.toString();
  return qs ? `?${qs}` : '';
}

const enc = encodeURIComponent;

// =============================================================================
// Read functions
// =============================================================================

export function listGraphEntities(
  params: GraphEntityListParams,
  signal?: AbortSignal,
): Promise<GraphEntityListResponse> {
  const query = buildGraphQuery({
    type: params.type,
    q: params.q?.trim() || undefined,
    transcriptId: params.transcriptId,
    sort: params.sort,
    cursor: params.cursor,
    limit: params.limit,
  });
  return api.get<GraphEntityListResponse>(`/graph/entities${query}`, { signal });
}

export function getGraphEntity(id: string, signal?: AbortSignal): Promise<GraphEntityDetail> {
  return api.get<GraphEntityDetail>(`/graph/entities/${enc(id)}`, { signal });
}

export function getEntityTimeline(
  id: string,
  params: TimelineParams = {},
  signal?: AbortSignal,
): Promise<TimelineResponse> {
  const query = buildGraphQuery({
    as_of: params.asOf,
    kinds: params.kinds,
    includeSensitive: params.includeSensitive ? 'true' : undefined,
    cursor: params.cursor,
    limit: params.limit,
  });
  return api.get<TimelineResponse>(`/graph/entities/${enc(id)}/timeline${query}`, { signal });
}

export function getEntityMentions(
  id: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<EntityMentionsResponse> {
  const query = buildGraphQuery({ cursor });
  return api.get<EntityMentionsResponse>(`/graph/entities/${enc(id)}/mentions${query}`, {
    signal,
  });
}

export function getEntityNeighborhood(
  id: string,
  params: GraphNeighborhoodParams = {},
  signal?: AbortSignal,
): Promise<GraphSlice> {
  const query = buildGraphQuery({
    hops: params.hops,
    types: params.types,
    relationTypes: params.relationTypes,
    as_of: params.asOf,
    limit: params.limit,
  });
  return api.get<GraphSlice>(`/graph/entities/${enc(id)}/neighborhood${query}`, { signal });
}

export function getEvidence(id: string, signal?: AbortSignal): Promise<EvidenceLink> {
  return api.get<EvidenceLink>(`/graph/evidence/${enc(id)}`, { signal });
}

/**
 * Batch evidence read. Chunked at `EVIDENCE_BATCH_MAX` per call — the API caps
 * `ids` at 50 and silently omits unknown ids, so a caller must not assume the
 * result has one row per id.
 */
export async function getEvidenceBatch(ids: readonly string[]): Promise<EvidenceLink[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += EVIDENCE_BATCH_MAX) {
    chunks.push(unique.slice(i, i + EVIDENCE_BATCH_MAX));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      api.get<{ items: EvidenceLink[] }>(`/graph/evidence${buildGraphQuery({ ids: chunk })}`),
    ),
  );
  return pages.flatMap((page) => page.items);
}

/** #372 — sections + stored digest. Never an AI call, never a 409. */
export function getEntityBrief(
  id: string,
  params: EntityBriefParams = {},
  signal?: AbortSignal,
): Promise<EntityBrief> {
  const query = buildGraphQuery({
    since: params.since,
    as_of: params.asOf,
    markViewed: params.markViewed === undefined ? undefined : String(params.markViewed),
  });
  return api.get<EntityBrief>(`/graph/entities/${enc(id)}/brief${query}`, { signal });
}

// =============================================================================
// Write functions
// =============================================================================

export function updateGraphEntity(id: string, body: GraphEntityPatch): Promise<GraphEntityRecord> {
  return api.patch<GraphEntityRecord>(`/graph/entities/${enc(id)}`, body);
}

export function forgetGraphEntity(id: string): Promise<ForgetEntityResponse> {
  return api.post<ForgetEntityResponse>(`/graph/entities/${enc(id)}/forget`, {
    confirmation: FORGET_CONFIRMATION,
  });
}

// =============================================================================
// Attribute definitions (#355, used by #369's settings card)
// =============================================================================

export interface AttributeChoice {
  value: string;
  label: string;
}

export interface AttributeDefOptions {
  choices?: AttributeChoice[];
  targetTypes?: string[];
}

/** One of the caller's own attribute definitions — #355's `GraphAttributeDefDto`, field for field. */
export interface AttributeDef {
  id: string;
  entityType: string;
  /** `u_` + ten lowercase alphanumerics; server-generated and permanent. */
  key: string;
  label: string;
  kind: AttributeKind;
  options: AttributeDefOptions | null;
  extractable: boolean;
  extractionHint: string | null;
  sensitivity: Sensitivity | null;
  sortOrder: number;
  deprecatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAttributeDefInput {
  entityType: string;
  label: string;
  kind: AttributeKind;
  options?: AttributeDefOptions;
  extractable?: boolean;
  extractionHint?: string | null;
  sensitivity?: Sensitivity | null;
  sortOrder?: number;
}

/** `kind`, `entityType` and `key` are deliberately absent: they are immutable. */
export interface PatchAttributeDefInput {
  label?: string;
  options?: AttributeDefOptions;
  extractable?: boolean;
  extractionHint?: string | null;
  sensitivity?: Sensitivity | null;
  sortOrder?: number;
  deprecated?: boolean;
}

/** #355's limit on `extractionHint`. */
export const EXTRACTION_HINT_MAX_LENGTH = 500;
/** #355's limit on `label`. */
export const ATTRIBUTE_LABEL_MAX_LENGTH = 80;

/** Human labels for each attribute kind. */
export const ATTRIBUTE_KIND_LABELS: Record<AttributeKind, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / no',
  select: 'One of a list',
  multi_select: 'Several of a list',
  url: 'Link',
  entity_ref: 'Link to another entity',
};

export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  business: 'Business',
  personal: 'Personal',
  sensitive: 'Sensitive',
};

/** `GET /api/graph/attribute-defs?includeDeprecated=true` — every own definition. */
export async function listAttributeDefs(entityType?: string): Promise<AttributeDef[]> {
  const params = new URLSearchParams({ includeDeprecated: 'true' });
  if (entityType) params.set('entityType', entityType);
  const result = await api.get<{ items: AttributeDef[] }>(
    `/graph/attribute-defs?${params.toString()}`,
  );
  return result.items;
}

export async function createAttributeDef(input: CreateAttributeDefInput): Promise<AttributeDef> {
  return api.post<AttributeDef>('/graph/attribute-defs', input);
}

export async function patchAttributeDef(
  id: string,
  input: PatchAttributeDefInput,
): Promise<AttributeDef> {
  return api.patch<AttributeDef>(`/graph/attribute-defs/${encodeURIComponent(id)}`, input);
}

/** `DELETE` DEPRECATES — the row and every stored value are kept (§17.3). */
export async function deprecateAttributeDef(id: string): Promise<AttributeDef> {
  return api.delete<AttributeDef>(`/graph/attribute-defs/${encodeURIComponent(id)}`);
}

/** The dialog's fields a server refusal can be attributed to. */
export type AttributeDefField =
  | 'entityType'
  | 'label'
  | 'kind'
  | 'choices'
  | 'targetTypes'
  | 'extractionHint'
  | 'sortOrder';

/**
 * Attribute a 400/409 from #355 to one dialog field, or `null` for a
 * form-level error.
 *
 * #355 answers with a sentence (and sometimes `details`), not a field path, so
 * this reads the `details` keys first and the sentence second. A refusal no
 * rule recognises stays form-level — shown, never swallowed.
 */
export function attributeDefErrorField(err: unknown): AttributeDefField | null {
  if (!(err instanceof ApiError) || (err.status !== 400 && err.status !== 409)) return null;

  const details = err.details;
  if (details && typeof details === 'object') {
    if ('removedChoices' in details) return 'choices';
    if ('invalidTargetTypes' in details) return 'targetTypes';
  }

  const message = err.message.toLowerCase();
  if (message.includes('extractionhint')) return 'extractionHint';
  if (message.includes('choice')) return 'choices';
  if (message.includes('targettypes')) return 'targetTypes';
  if (message.includes('entity type') || message.includes('attributes on')) return 'entityType';
  if (message.includes('label')) return 'label';
  if (message.includes('sortorder')) return 'sortOrder';
  return null;
}
