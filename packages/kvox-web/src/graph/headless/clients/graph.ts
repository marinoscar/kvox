/**
 * The knowledge-graph client — epic #347 (read side: #373), epic #344/#346
 * (ontology, edit, forget).
 *
 * ONE EXPORTED FUNCTION PER ENDPOINT, and every response shape is a TS
 * interface MIRRORING the API's Zod schema field for field:
 *
 *   - #370 `packages/kvox-api/src/graph/read/dto/graph-read.dto.ts` — entity index,
 *     detail, neighbourhood, timeline, mentions, evidence links.
 *   - #372 `packages/kvox-api/src/graph/brief/dto/entity-brief.dto.ts` — the brief.
 *   - #354 `GET /api/graph/ontology` — `EffectiveSchemaPayload`, IMPORTED from
 *     `@marinoscar/kvox-contract/ontology` rather than re-declared, so a drift fails `tsc`.
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
  AttributeKind as ContractAttributeKind,
  EffectiveAttributePayload,
  EffectiveEntityTypePayload,
  EffectiveRelationTypePayload,
  EffectiveSchemaPayload,
  Sensitivity as ContractSensitivity,
} from '@marinoscar/kvox-contract/ontology';

import {
  KvoxApiError,
  kvoxDelete,
  kvoxGet,
  kvoxPatch,
  kvoxPost,
  kvoxPostFormData,
} from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';
import type {
  GraphEntityRef as ContractGraphEntityRef,
  GraphEntityDetail as ContractGraphEntityDetail,
  GraphNode as ContractGraphNode,
  TimelineEvent as ContractTimelineEvent,
  TimelineResponse as ContractTimelineResponse,
  EvidenceLink as ContractEvidenceLink,
  CitedStatement as ContractCitedStatement,
  BriefEntry as ContractBriefEntry,
  PeopleChange as ContractPeopleChange,
  RelatedSource as ContractRelatedSource,
  DigestUnavailableReason as ContractDigestUnavailableReason,
  ForgetEntityResponse as ContractForgetEntityResponse,
  ProposalStatus as ContractProposalStatus,
  ProposalDecision as ContractProposalDecision,
  ProposalItemFlag as ContractProposalItemFlag,
  EndpointRef as ContractEndpointRef,
  EvidenceSpanInput as ContractEvidenceSpanInput,
  RelinkField as ContractRelinkField,
  BulkSkipReason as ContractBulkSkipReason,
  RevertKept as ContractRevertKept,
  RevertResult as ContractRevertResult,
  ExtractionEstimate as ContractExtractionEstimate,
  GraphConflictReason as ContractGraphConflictReason,
  UserGuidance as ContractUserGuidance,
  GraphOverviewRefreshResponse as ContractGraphOverviewRefreshResponse,
  GraphExportFormat as ContractGraphExportFormat,
  CreateGraphExportResponse as ContractCreateGraphExportResponse,
  GraphImportFormat as ContractGraphImportFormat,
  GraphImportFailureReason as ContractGraphImportFailureReason,
  GraphImportViolation as ContractGraphImportViolation,
  CreateGraphImportResponse as ContractCreateGraphImportResponse,
} from '@marinoscar/kvox-contract/graph';
import type { AttributeChoice as ContractAttributeChoice } from '@marinoscar/kvox-contract/ontology';

// =============================================================================
// Ontology (#354) — the payload every graph form is generated from
// =============================================================================

/**
 * The graph ontology.
 *
 * @stability experimental
 */
export type GraphOntology = EffectiveSchemaPayload;
/**
 * The graph attribute def.
 *
 * @stability experimental
 */
export type GraphAttributeDef = EffectiveAttributePayload;
/**
 * The graph entity type def.
 *
 * @stability experimental
 */
export type GraphEntityTypeDef = EffectiveEntityTypePayload;
/**
 * The graph relation type def.
 *
 * @stability experimental
 */
export type GraphRelationTypeDef = EffectiveRelationTypePayload;
/**
 * #369's names for the same payload's parts (the settings card uses these).
 *
 * @stability experimental
 */
export type GraphEntityType = EffectiveSchemaPayload['entityTypes'][number];
/**
 * The graph attribute.
 *
 * @stability experimental
 */
export type GraphAttribute = GraphEntityType['attributes'][number];
/**
 * The graph domain.
 *
 * @stability experimental
 */
export type GraphDomain = EffectiveSchemaPayload['domains'][number];

/**
 * The attribute kind the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type AttributeKind = ContractAttributeKind;
/**
 * The sensitivity the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type Sensitivity = ContractSensitivity;

/**
 * Gets graph ontology.
 *
 * @stability experimental
 */
export function getGraphOntology(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphOntology> {
  return kvoxGet<GraphOntology>(host, '/graph/ontology', { signal });
}

// =============================================================================
// Shared value types
// =============================================================================

/**
 * The date precision.
 *
 * @stability experimental
 */
export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';
/**
 * The graph item kind.
 *
 * @stability experimental
 */
export type GraphItemKind = 'commitment' | 'decision' | 'claim' | 'person_fact';

/** `entityRef` in both #370 and #372. */
/**
 * The graph entity ref the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphEntityRef = ContractGraphEntityRef;

// =============================================================================
// Entity index + detail (#370)
// =============================================================================

/**
 * The graph entity summary.
 *
 * @stability experimental
 */
export interface GraphEntitySummary {
  /** The id. */
  id: string;
  /** The type. */
  type: string;
  /** The label. */
  label: string;
  /** At most five. */
  aliases: string[];
  /** The mention count. */
  mentionCount: number;
  /** Max `occurred_at` of Meetings this entity has evidence in. */
  lastSeenAt: string | null;
  /** Present only with `?transcriptId`. */
  speakerIds?: string[];
}

/**
 * The graph entity list params of the call.
 *
 * @stability experimental
 */
export interface GraphEntityListParams {
  /** The type. */
  type?: readonly string[];
  /** The q. */
  q?: string;
  /** The id of the transcript. */
  transcriptId?: string;
  /** The sort. */
  sort?: 'updated' | 'viewed';
  /** The cursor. */
  cursor?: string;
  /** The limit. */
  limit?: number;
}

/**
 * The graph entity list response the API answers.
 *
 * @stability experimental
 */
export interface GraphEntityListResponse {
  /** The items. */
  items: GraphEntitySummary[];
  /** Always `null` when `q` is set (top-`limit` by similarity). */
  nextCursor: string | null;
}

/**
 * The graph alias source.
 *
 * @stability experimental
 */
export type GraphAliasSource = 'user' | 'extraction' | 'speaker_naming' | 'import';

/**
 * The graph entity alias.
 *
 * @stability experimental
 */
export interface GraphEntityAlias {
  /** The id. */
  id: string;
  /** The alias. */
  alias: string;
  /** The source. */
  source: GraphAliasSource;
}

/**
 * The graph entity counts.
 *
 * @stability experimental
 */
export interface GraphEntityCounts {
  /** The relations. */
  relations: number;
  /** The mentions. */
  mentions: number;
  /** The evidence. */
  evidence: number;
  /** The items. */
  items: {
    /** The commitment. */
    commitment: number;
    /** The decision. */
    decision: number;
    /** The claim. */
    claim: number;
    /** The person fact. */
    person_fact: number;
  };
  /** Whether open commitments applies. */
  openCommitments: number;
}

/**
 * The graph entity detail the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphEntityDetail = ContractGraphEntityDetail;

// =============================================================================
// Graph slice (#370) — neighbourhood + expand
// =============================================================================

/**
 * The graph node the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphNode = ContractGraphNode;

/**
 * The graph valid range.
 *
 * @stability experimental
 */
export interface GraphValidRange {
  /** The from. */
  from: string | null;
  /** The to. */
  to: string | null;
  /** The precision. */
  precision: DatePrecision;
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The graph edge.
 *
 * @stability experimental
 */
export interface GraphEdge {
  /** `kg_relations.id`, or `virt:<itemId>:<TYPE>` for column-derived edges. */
  id: string;
  /** The type. */
  type: string;
  /** Stored direction, never inverted. */
  source: string;
  /** The target. */
  target: string;
  /** The valid. */
  valid: GraphValidRange | null;
  /** The confidence. */
  confidence: number | null;
  /** Whether virtual applies. */
  virtual: boolean;
  /**
   * The relation's own attribute values, keyed by prop key — e.g. `HAS_ROLE`
   * `{ title, businessUnit }` (#440/#442). Only declared, non-deprecated,
   * non-sensitive, non-null props, in declaration order; `{}` otherwise.
   * Optional here because an older API omits it — read it as `{}` when absent.
   */
  props?: Record<string, unknown>;
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The graph slice.
 *
 * @stability experimental
 */
export interface GraphSlice {
  /** The seed ids. */
  seedIds: string[];
  /** The as of. */
  asOf: string;
  /** The nodes. */
  nodes: GraphNode[];
  /** The edges. */
  edges: GraphEdge[];
  /** Whether truncated applies. */
  truncated: boolean;
  /** The cap. */
  cap: number;
}

/**
 * The graph neighborhood params of the call.
 *
 * @stability experimental
 */
export interface GraphNeighborhoodParams {
  /** The hops. */
  hops?: 1 | 2;
  /** The types. */
  types?: readonly string[];
  /** The relation types. */
  relationTypes?: readonly string[];
  /** The as of. */
  asOf?: string;
  /** The limit. */
  limit?: number;
}

// =============================================================================
// Timeline + mentions (#370)
// =============================================================================

/**
 * The timeline item.
 *
 * @stability experimental
 */
export interface TimelineItem {
  /** The id. */
  id: string;
  /** The kind. */
  kind: GraphItemKind;
  /** The title. */
  title: string | null;
  /** The statement. */
  statement: string;
  /** The status. */
  status: string | null;
  /** When the due happened, as an ISO timestamp. */
  dueAt: string | null;
  /** The owner person. */
  ownerPerson: GraphEntityRef | null;
  /** The counterparty. */
  counterparty: GraphEntityRef | null;
  /** The sensitivity. */
  sensitivity: 'business' | 'personal' | 'sensitive' | null;
  /** Whether superseded applies. */
  superseded: boolean;
  /** The id of the superseded by. */
  supersededById: string | null;
}

/**
 * The timeline relation.
 *
 * @stability experimental
 */
export interface TimelineRelation {
  /** The id. */
  id: string;
  /** The type. */
  type: string;
  /** The direction. */
  direction: 'out' | 'in';
  /** The other. */
  other: GraphEntityRef;
  /** The valid. */
  valid: GraphValidRange | null;
}

/**
 * The timeline event the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type TimelineEvent = ContractTimelineEvent;

/**
 * The timeline params of the call.
 *
 * @stability experimental
 */
export interface TimelineParams {
  /** The as of. */
  asOf?: string;
  /** The kinds. */
  kinds?: readonly string[];
  /** Whether include sensitive applies. */
  includeSensitive?: boolean;
  /** The cursor. */
  cursor?: string;
  /** The limit. */
  limit?: number;
}

/**
 * The timeline response the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type TimelineResponse = ContractTimelineResponse;

/**
 * The entity mention.
 *
 * @stability experimental
 */
export interface EntityMention {
  /** The kind. */
  kind: 'note' | 'transcript';
  /** The id. */
  id: string;
  /** The title. */
  title: string | null;
  /** When the occurred happened, as an ISO timestamp. */
  occurredAt: string | null;
  /** Whether available applies. */
  available: boolean;
}

/**
 * The entity mentions response the API answers.
 *
 * @stability experimental
 */
export interface EntityMentionsResponse {
  /** The items. */
  items: EntityMention[];
  /** The next cursor. */
  nextCursor: string | null;
}

// =============================================================================
// Evidence links (#370)
// =============================================================================

/**
 * The segment evidence source.
 *
 * @stability experimental
 */
export interface SegmentEvidenceSource {
  /** The kind. */
  kind: 'segment';
  /** The id of the transcript. */
  transcriptId: string | null;
  /** The transcript title. */
  transcriptTitle: string | null;
  /** The id of the segment. */
  segmentId: string | null;
  /** The segment rev. */
  segmentRev: number | null;
  /** The current segment rev. */
  currentSegmentRev: number | null;
  /** The start ms. */
  startMs: number | null;
  /** The end ms. */
  endMs: number | null;
  /** Whether text changed applies. */
  textChanged: boolean;
  /** Whether available applies. */
  available: boolean;
  /** The href. */
  href: string | null;
}

/**
 * The note evidence source.
 *
 * @stability experimental
 */
export interface NoteEvidenceSource {
  /** The kind. */
  kind: 'note';
  /** The id of the note. */
  noteId: string | null;
  /** The note title. */
  noteTitle: string | null;
  /** The note version. */
  noteVersion: number | null;
  /** The current note version. */
  currentNoteVersion: number | null;
  /** The char start. */
  charStart: number | null;
  /** The char end. */
  charEnd: number | null;
  /** Whether version changed applies. */
  versionChanged: boolean;
  /** Whether available applies. */
  available: boolean;
  /** The href. */
  href: string | null;
}

/**
 * The import evidence source.
 *
 * @stability experimental
 */
export interface ImportEvidenceSource {
  /** The kind. */
  kind: 'import';
  /** The id of the import object. */
  importObjectId: string | null;
  /** The source iri. */
  sourceIri: string | null;
  /** Whether available applies. */
  available: boolean;
  /** The href. */
  href: null;
}

/**
 * The evidence source.
 *
 * @stability experimental
 */
export type EvidenceSource = SegmentEvidenceSource | NoteEvidenceSource | ImportEvidenceSource;

/**
 * The evidence link the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type EvidenceLink = ContractEvidenceLink;

/**
 * The API's cap on one `GET /api/graph/evidence?ids=` call.
 *
 * @stability experimental
 */
export const EVIDENCE_BATCH_MAX = 50;

// =============================================================================
// Brief (#372)
// =============================================================================

/**
 * The cited statement the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type CitedStatement = ContractCitedStatement;

/**
 * The brief entry the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type BriefEntry = ContractBriefEntry;

/**
 * The people change the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type PeopleChange = ContractPeopleChange;

/**
 * The related source the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type RelatedSource = ContractRelatedSource;

/**
 * The digest unavailable reason the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type DigestUnavailableReason = ContractDigestUnavailableReason;

/**
 * The entity digest.
 *
 * @stability experimental
 */
export interface EntityDigest {
  /** The statements. */
  statements: CitedStatement[];
  /** The covers until. */
  coversUntil: string | null;
  /** When the generated happened, as an ISO timestamp. */
  generatedAt: string;
  /** The model. */
  model: string;
}

/**
 * The entity brief.
 *
 * @stability experimental
 */
export interface EntityBrief {
  /** The entity. */
  entity: GraphEntityRef;
  /** The window. */
  window: {
    /** The since. */
    since: string | null;
    /** The since source. */
    sinceSource: 'query' | 'last_viewed' | 'digest' | 'default';
    /** The as of. */
    asOf: string;
    /** When the last viewed happened, as an ISO timestamp. */
    lastViewedAt: string | null;
  };
  /** The digest. */
  digest: EntityDigest | null;
  /** Whether digest stale applies. */
  digestStale: boolean;
  /** Whether digest pending applies. */
  digestPending: boolean;
  /** The digest unavailable. */
  digestUnavailable: DigestUnavailableReason | null;
  /** The sections. */
  sections: {
    /** The what changed. */
    whatChanged: BriefEntry[];
    /** The decisions. */
    decisions: BriefEntry[];
    /** Whether open commitments applies. */
    openCommitments: {
      /** The theirs. */
      theirs: BriefEntry[];
      /** The yours. */
      yours: BriefEntry[];
    };
    /** The risks claims. */
    risksClaims: BriefEntry[];
    /** The people changes. */
    peopleChanges: PeopleChange[];
  };
  /** The related. */
  related: RelatedSource[];
}

/**
 * The entity brief params of the call.
 *
 * @stability experimental
 */
export interface EntityBriefParams {
  /** The since. */
  since?: string;
  /** The as of. */
  asOf?: string;
  /** Whether mark viewed applies. */
  markViewed?: boolean;
}

// =============================================================================
// Writes (#355, #357)
// =============================================================================

/**
 * #355's request shape. `type` is deliberately absent — a type changes only through a proposal.
 *
 * @stability experimental
 */
export interface GraphEntityPatch {
  /** The label. */
  label?: string;
  /** Merge: `key → value` sets, `key → null` clears, absent keys unchanged. */
  props?: Record<string, unknown>;
  /** The add aliases. */
  addAliases?: string[];
  /** The remove alias ids. */
  removeAliasIds?: string[];
}

/**
 * #355's response projection (`graphEntitySchema`), which is NOT the #370 detail.
 *
 * @stability experimental
 */
export interface GraphEntityRecord {
  /** The id. */
  id: string;
  /** The type. */
  type: string;
  /** The label. */
  label: string;
  /** The props. */
  props: Record<string, unknown>;
  /** The review status. */
  reviewStatus: string;
  /** The id of the merged into. */
  mergedIntoId: string | null;
  /** When the occurred happened, as an ISO timestamp. */
  occurredAt: string | null;
  /** The ontology version. */
  ontologyVersion: string;
  /** The aliases. */
  aliases: Array<GraphEntityAlias & {
    /** The normalized. */
    normalized: string;
    /** When the created happened, as an ISO timestamp. */
    createdAt: string;
  }>;
  /** When the created happened, as an ISO timestamp. */
  createdAt: string;
  /** When the updated happened, as an ISO timestamp. */
  updatedAt: string;
}

/**
 * The FORGET CONFIRMATION.
 *
 * @stability experimental
 */
export const FORGET_CONFIRMATION = 'FORGET';

/**
 * The forget entity response the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type ForgetEntityResponse = ContractForgetEntityResponse;

// =============================================================================
// Query-string helper
// =============================================================================

/**
 * The query value.
 *
 * @stability experimental
 */
export type QueryValue = string | number | boolean | readonly string[] | undefined | null;

/**
 * Build `?a=1&b=x,y`, dropping empty values. Arrays are comma-joined (the API's `csv`).
 *
 * @stability experimental
 */
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

/**
 * Lists graph entities.
 *
 * @stability experimental
 */
export function listGraphEntities(
  host: KvoxWebHost,
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
  return kvoxGet<unknown>(host, `/graph/entities${query}`, { signal }).then(
    parseGraphEntityListResponse,
  );
}

/**
 * Refuse a list response that is not the shape the API's Zod schema promises.
 *
 * ⚠ LOAD-BEARING, NOT DEFENSIVE NOISE. `useGraphEntities` feeds `items` into
 * render code (`KnowledgeSection` reads `.length` on Home), so a body without
 * an `items` array — a proxy's error page, a stub answering `{}` — used to
 * reach React as `undefined` and throw during render, taking the WHOLE app
 * into `ErrorBoundary` rather than just the section. Rejecting here turns it
 * into an ordinary failed request, which every caller already handles (Home's
 * Knowledge section hides; the index page shows its error).
  *
 * @stability experimental
 */
export function parseGraphEntityListResponse(body: unknown): GraphEntityListResponse {
  if (typeof body === 'object' && body !== null) {
    const { items, nextCursor } = body as { items?: unknown; nextCursor?: unknown };
    if (Array.isArray(items)) {
      return {
        items: items as GraphEntitySummary[],
        nextCursor: typeof nextCursor === 'string' ? nextCursor : null,
      };
    }
  }
  throw new Error('Unexpected response from /graph/entities');
}

/**
 * Gets graph entity.
 *
 * @stability experimental
 */
export function getGraphEntity(host: KvoxWebHost, id: string, signal?: AbortSignal): Promise<GraphEntityDetail> {
  return kvoxGet<GraphEntityDetail>(host, `/graph/entities/${enc(id)}`, { signal });
}

/**
 * Gets entity timeline.
 *
 * @stability experimental
 */
export function getEntityTimeline(
  host: KvoxWebHost,
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
  return kvoxGet<TimelineResponse>(host, `/graph/entities/${enc(id)}/timeline${query}`, { signal });
}

/**
 * Gets entity mentions.
 *
 * @stability experimental
 */
export function getEntityMentions(
  host: KvoxWebHost,
  id: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<EntityMentionsResponse> {
  const query = buildGraphQuery({ cursor });
  return kvoxGet<EntityMentionsResponse>(host, `/graph/entities/${enc(id)}/mentions${query}`, {
    signal,
  });
}

/**
 * Gets entity neighborhood.
 *
 * @stability experimental
 */
export function getEntityNeighborhood(
  host: KvoxWebHost,
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
  return kvoxGet<GraphSlice>(host, `/graph/entities/${enc(id)}/neighborhood${query}`, { signal });
}

/**
 * #370's cap on one slice, and on the explorer (§22.2).
 *
 * @stability experimental
 */
export const GRAPH_NODE_CAP = 300;
/**
 * #370's cap on `nodeIds` in one expand.
 *
 * @stability experimental
 */
export const GRAPH_EXPAND_MAX_SEEDS = 50;

/**
 * The graph expand params of the call.
 *
 * @stability experimental
 */
export interface GraphExpandParams {
  /** 1–50 readable entity or item ids. Any unreadable one → 404 for the whole call. */
  nodeIds: readonly string[];
  /** Entity type keys / item kinds expansion may ADD (seeds are always kept). */
  types?: readonly string[];
  /** Relation types expansion may walk along. */
  relationTypes?: readonly string[];
  /** `YYYY-MM-DD` or an ISO datetime with offset. */
  asOf?: string;
  /** 1–300. */
  cap: number;
}

/**
 * `POST /api/graph/explore/expand` (#370) — one hop out from each node, as one
 * slice. A read, even though it is a POST. `asOf` is sent as the API's
 * `as_of`; an absent filter is omitted rather than sent empty, because an
 * empty list would mean "nothing" rather than "everything".
  *
 * @stability experimental
 */
export function expandGraph(host: KvoxWebHost, params: GraphExpandParams, signal?: AbortSignal): Promise<GraphSlice> {
  const body: Record<string, unknown> = { nodeIds: [...params.nodeIds], cap: params.cap };
  if (params.types) body.types = [...params.types];
  if (params.relationTypes) body.relationTypes = [...params.relationTypes];
  if (params.asOf) body.as_of = params.asOf;
  return kvoxPost<GraphSlice>(host, '/graph/explore/expand', body, { signal });
}

/**
 * Gets evidence.
 *
 * @stability experimental
 */
export function getEvidence(host: KvoxWebHost, id: string, signal?: AbortSignal): Promise<EvidenceLink> {
  return kvoxGet<EvidenceLink>(host, `/graph/evidence/${enc(id)}`, { signal });
}

/**
 * Batch evidence read. Chunked at `EVIDENCE_BATCH_MAX` per call — the API caps
 * `ids` at 50 and silently omits unknown ids, so a caller must not assume the
 * result has one row per id.
  *
 * @stability experimental
 */
export async function getEvidenceBatch(host: KvoxWebHost, ids: readonly string[]): Promise<EvidenceLink[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const chunks: string[][] = [];
  for (let i = 0; i < unique.length; i += EVIDENCE_BATCH_MAX) {
    chunks.push(unique.slice(i, i + EVIDENCE_BATCH_MAX));
  }
  const pages = await Promise.all(
    chunks.map((chunk) =>
      kvoxGet<{ items: EvidenceLink[] }>(host, `/graph/evidence${buildGraphQuery({ ids: chunk })}`),
    ),
  );
  return pages.flatMap((page) => page.items);
}

/**
 * #372 — sections + stored digest. Never an AI call, never a 409.
 *
 * @stability experimental
 */
export function getEntityBrief(
  host: KvoxWebHost,
  id: string,
  params: EntityBriefParams = {},
  signal?: AbortSignal,
): Promise<EntityBrief> {
  const query = buildGraphQuery({
    since: params.since,
    as_of: params.asOf,
    markViewed: params.markViewed === undefined ? undefined : String(params.markViewed),
  });
  return kvoxGet<EntityBrief>(host, `/graph/entities/${enc(id)}/brief${query}`, { signal });
}

// =============================================================================
// Write functions
// =============================================================================

/**
 * Updates graph entity.
 *
 * @stability experimental
 */
export function updateGraphEntity(host: KvoxWebHost, id: string, body: GraphEntityPatch): Promise<GraphEntityRecord> {
  return kvoxPatch<GraphEntityRecord>(host, `/graph/entities/${enc(id)}`, body);
}

/**
 * Forgets graph entity.
 *
 * @stability experimental
 */
export function forgetGraphEntity(host: KvoxWebHost, id: string): Promise<ForgetEntityResponse> {
  return kvoxPost<ForgetEntityResponse>(host, `/graph/entities/${enc(id)}/forget`, {
    confirmation: FORGET_CONFIRMATION,
  });
}

// =============================================================================
// Attribute definitions (#355, used by #369's settings card)
// =============================================================================

/**
 * The attribute choice the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type AttributeChoice = ContractAttributeChoice;

/**
 * The attribute def options of the call.
 *
 * @stability experimental
 */
export interface AttributeDefOptions {
  /** The choices. */
  choices?: AttributeChoice[];
  /** The target types. */
  targetTypes?: string[];
}

/**
 * One of the caller's own attribute definitions — #355's `GraphAttributeDefDto`, field for field.
 *
 * @stability experimental
 */
export interface AttributeDef {
  /** The id. */
  id: string;
  /** The entity type. */
  entityType: string;
  /** `u_` + ten lowercase alphanumerics; server-generated and permanent. */
  key: string;
  /** The label. */
  label: string;
  /** The kind. */
  kind: AttributeKind;
  /** The options. */
  options: AttributeDefOptions | null;
  /** Whether extractable applies. */
  extractable: boolean;
  /** The extraction hint. */
  extractionHint: string | null;
  /** The sensitivity. */
  sensitivity: Sensitivity | null;
  /** The sort order. */
  sortOrder: number;
  /** When the deprecated happened, as an ISO timestamp. */
  deprecatedAt: string | null;
  /** When the created happened, as an ISO timestamp. */
  createdAt: string;
  /** When the updated happened, as an ISO timestamp. */
  updatedAt: string;
}

/**
 * The create attribute def input of the call.
 *
 * @stability experimental
 */
export interface CreateAttributeDefInput {
  /** The entity type. */
  entityType: string;
  /** The label. */
  label: string;
  /** The kind. */
  kind: AttributeKind;
  /** The options. */
  options?: AttributeDefOptions;
  /** Whether extractable applies. */
  extractable?: boolean;
  /** The extraction hint. */
  extractionHint?: string | null;
  /** The sensitivity. */
  sensitivity?: Sensitivity | null;
  /** The sort order. */
  sortOrder?: number;
}

/**
 * `kind`, `entityType` and `key` are deliberately absent: they are immutable.
 *
 * @stability experimental
 */
export interface PatchAttributeDefInput {
  /** The label. */
  label?: string;
  /** The options. */
  options?: AttributeDefOptions;
  /** Whether extractable applies. */
  extractable?: boolean;
  /** The extraction hint. */
  extractionHint?: string | null;
  /** The sensitivity. */
  sensitivity?: Sensitivity | null;
  /** The sort order. */
  sortOrder?: number;
  /** Whether deprecated applies. */
  deprecated?: boolean;
}

/**
 * #355's limit on `extractionHint`.
 *
 * @stability experimental
 */
export const EXTRACTION_HINT_MAX_LENGTH = 500;
/**
 * #355's limit on `label`.
 *
 * @stability experimental
 */
export const ATTRIBUTE_LABEL_MAX_LENGTH = 80;

/**
 * Human labels for each attribute kind.
 *
 * @stability experimental
 */
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

/**
 * The SENSITIVITY LABELS.
 *
 * @stability experimental
 */
export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  business: 'Business',
  personal: 'Personal',
  sensitive: 'Sensitive',
};

/**
 * `GET /api/graph/attribute-defs?includeDeprecated=true` — every own definition.
 *
 * @stability experimental
 */
export async function listAttributeDefs(host: KvoxWebHost, entityType?: string): Promise<AttributeDef[]> {
  const params = new URLSearchParams({ includeDeprecated: 'true' });
  if (entityType) params.set('entityType', entityType);
  const result = await kvoxGet<{ items: AttributeDef[] }>(host, 
    `/graph/attribute-defs?${params.toString()}`,
  );
  return result.items;
}

/**
 * Creates attribute def.
 *
 * @stability experimental
 */
export async function createAttributeDef(host: KvoxWebHost, input: CreateAttributeDefInput): Promise<AttributeDef> {
  return kvoxPost<AttributeDef>(host, '/graph/attribute-defs', input);
}

/**
 * Patches attribute def.
 *
 * @stability experimental
 */
export async function patchAttributeDef(
  host: KvoxWebHost,
  id: string,
  input: PatchAttributeDefInput,
): Promise<AttributeDef> {
  return kvoxPatch<AttributeDef>(host, `/graph/attribute-defs/${encodeURIComponent(id)}`, input);
}

/**
 * `DELETE` DEPRECATES — the row and every stored value are kept (§17.3).
 *
 * @stability experimental
 */
export async function deprecateAttributeDef(host: KvoxWebHost, id: string): Promise<AttributeDef> {
  return kvoxDelete<AttributeDef>(host, `/graph/attribute-defs/${encodeURIComponent(id)}`);
}

/**
 * The dialog's fields a server refusal can be attributed to.
 *
 * @stability experimental
 */
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
  *
 * @stability experimental
 */
export function attributeDefErrorField(err: unknown): AttributeDefField | null {
  if (!(err instanceof KvoxApiError) || (err.status !== 400 && err.status !== 409)) return null;

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

// =============================================================================
// Proposals — the review sheet's transport (#367, epic #346)
// =============================================================================
//
// Mirrors the Contract of #366 (`packages/kvox-api/src/graph-extraction/proposals/dto/proposal.dto.ts`)
// field for field, plus #363's `POST /api/graph/notes/:noteId/extract` and
// `proposal-payload.schema.ts`, and #370's entity search. Components import
// these types and functions; none of them learns a URL.

/**
 * The proposal status the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type ProposalStatus = ContractProposalStatus;
/**
 * The proposal kind.
 *
 * @stability experimental
 */
export type ProposalKind = 'extraction' | 'import' | 'resolution';
/**
 * The proposal decision the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type ProposalDecision = ContractProposalDecision;
/**
 * The proposal group key.
 *
 * @stability experimental
 */
export type ProposalGroupKey =
  | 'Person'
  | 'Organization'
  | 'Project'
  | 'Meeting'
  | 'Decision'
  | 'Commitment'
  | 'Claim'
  | 'PersonFact'
  | 'Other'
  | 'relations'
  | 'closings';

/**
 * #366's `groupKeySchema` order — the order the sheet renders groups in.
 *
 * @stability experimental
 */
export const PROPOSAL_GROUP_ORDER: readonly ProposalGroupKey[] = [
  'Person',
  'Organization',
  'Project',
  'Meeting',
  'Decision',
  'Commitment',
  'Claim',
  'PersonFact',
  'Other',
  'relations',
  'closings',
];

/**
 * #363's `PROPOSAL_ITEM_FLAGS` (`graph/proposals/proposal-payload.schema.ts`),
 * copied verbatim — the web cannot import from the API. `review/flagCopy.ts`
 * is a `Record` over this union, so a flag added here without copy fails `tsc`.
  *
 * @stability experimental
 */
export const PROPOSAL_ITEM_FLAGS = [
  'known',
  'possible_duplicate',
  'supersedes',
  'overlaps',
  'unordered',
  'closing_affects_commitments',
  'sensitive',
  'ambiguous',
  'type_changed',
  'previously_rejected',
  'quote_not_located',
  'model_claimed_match',
  'stale_ontology',
  'imported',
] as const;
/**
 * The proposal item flag the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type ProposalItemFlag = ContractProposalItemFlag;

/**
 * The valid precision value.
 *
 * @stability experimental
 */
export type ValidPrecisionValue = 'day' | 'month' | 'year' | 'unknown';

/** `{ entityId }` — an existing committed entity; `{ ref }` — an entity row of this proposal. */
/**
 * The endpoint ref the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type EndpointRef = ContractEndpointRef;

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The proposal counts.
 *
 * @stability experimental
 */
export interface ProposalCounts {
  /** The total. */
  total: number;
  /** The pending. */
  pending: number;
  /** The accepted. */
  accepted: number;
  /** The rejected. */
  rejected: number;
  /** The known. */
  known: number;
  /** The by group. */
  byGroup: Partial<Record<ProposalGroupKey, number>>;
}

/**
 * #363's `userGuidanceSchema`.
 *
 * @stability experimental
 */
export interface ProposalUserGuidance {
  /** The pinned entity ids. */
  pinnedEntityIds: string[];
  /** The entity types. */
  entityTypes?: string[];
  /** The relation types. */
  relationTypes?: string[];
  /** The instructions. */
  instructions: string;
}

/**
 * Why an extraction proposal failed — `kg_proposals.stats.failure.errorClass`.
 *
 * `'truncated'` (#435): the model's answer hit its output ceiling even after
 * the run re-asked once for a smaller answer (`stats.truncationRetry`).
 * Distinct from `'invalid_output'`, a malformed answer. Open-ended: a class a
 * later API adds still arrives as a string and renders its server message.
  *
 * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export type ExtractionFailureClass =
  | 'auth'
  | 'refusal'
  | 'rate_limit'
  | 'budget'
  | 'truncated'
  | 'invalid_output'
  | 'other'
  | (string & {});

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The proposal summary.
 *
 * @stability experimental
 */
export interface ProposalSummary {
  /** The id. */
  id: string;
  /** The kind. */
  kind: ProposalKind;
  /** The status. */
  status: ProposalStatus;
  /** The id of the note. */
  noteId: string | null;
  /** The note title. */
  noteTitle: string | null;
  /** The note version. */
  noteVersion: number | null;
  /** The note current version. */
  noteCurrentVersion: number | null;
  /** The model. */
  model: string | null;
  /** The id of the provider. */
  providerId: string | null;
  /** The user guidance. */
  userGuidance: ProposalUserGuidance | null;
  /** The counts. */
  counts: ProposalCounts;
  /**
   * Stage stats, loosely typed. Known keys include `usage`, `proposed`, and
   * (#435) the optional `truncationRetry: boolean` — the first answer was cut
   * off and the run re-asked once with halved row caps.
   */
  stats: Record<string, unknown> & {
    /** Whether truncation retry applies. */
    truncationRetry?: boolean;
  };
  /** The failure. */
  failure: {
    /** The error class. */
    errorClass: ExtractionFailureClass;
    /** The message. */
    message: string;
  } | null;
  /** When the created happened, as an ISO timestamp. */
  createdAt: string;
  /** When the committed happened, as an ISO timestamp. */
  committedAt: string | null;
  /** When the reverted happened, as an ISO timestamp. */
  revertedAt: string | null;
}

/**
 * The proposal evidence.
 *
 * @stability experimental
 */
export interface ProposalEvidence {
  /** The id. */
  id: string;
  /** `import` (#387): cited to the uploaded RDF file itself — nothing to play or highlight. */
  source: 'segment' | 'note' | 'import';
  /** The id of the transcript. */
  transcriptId: string | null;
  /** The id of the segment. */
  segmentId: string | null;
  /** The segment rev. */
  segmentRev: number | null;
  /** The start ms. */
  startMs: number | null;
  /** The end ms. */
  endMs: number | null;
  /** The id of the note. */
  noteId: string | null;
  /** The note version. */
  noteVersion: number | null;
  /** The char start. */
  charStart: number | null;
  /** The char end. */
  charEnd: number | null;
  /** The quote. */
  quote: string;
  /** Import evidence (#387): the stored file and the node's IRI in it. */
  importObjectId?: string | null;
  /** The source iri. */
  sourceIri?: string | null;
  /** The speaker name. */
  speakerName: string | null;
  /** Whether stale applies. */
  stale: boolean;
}

/**
 * The proposal resolution candidate.
 *
 * @stability experimental
 */
export interface ProposalResolutionCandidate {
  /** The id of the entity. */
  entityId: string;
  /** The label. */
  label: string;
  /** The type. */
  type: string;
  /** The score. */
  score: number;
  /** The signals. */
  signals: string[];
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The proposal resolution.
 *
 * @stability experimental
 */
export interface ProposalResolution {
  /** The linked existing entity id; null = new. */
  ref: string | null;
  /** The score. */
  score: number | null;
  /** The source. */
  source: string | null;
  /** The candidates. */
  candidates: ProposalResolutionCandidate[];
  /** The adjudication. */
  adjudication: {
    /** The verdict. */
    verdict: 'same' | 'different' | 'uncertain';
    /** The rationale. */
    rationale: string;
    /** The model. */
    model: string;
  } | null;
  /** Label of `ref` / the `mergeIntoId` target. */
  refLabel: string | null;
}

/**
 * The proposal item.
 *
 * @stability experimental
 */
export interface ProposalItem {
  /** The id. */
  id: string;
  /** The kind. */
  kind: 'entity' | 'relation' | 'item' | 'closing';
  /** The origin. */
  origin: 'ai' | 'user';
  /** The group key. */
  groupKey: ProposalGroupKey;
  /** The decision. */
  decision: ProposalDecision;
  /** The payload. */
  payload: Record<string, unknown>;
  /** The edited payload. */
  editedPayload: Record<string, unknown> | null;
  /** The effective payload. */
  effectivePayload: Record<string, unknown>;
  /** The display. */
  display: {
    /** The title. */
    title: string;
    /** The subtitle. */
    subtitle: string | null;
  };
  /** The resolution. */
  resolution: ProposalResolution | null;
  /** The id of the merge into. */
  mergeIntoId: string | null;
  /** The distinct from. */
  distinctFrom: string[];
  /** Values of {@link PROPOSAL_ITEM_FLAGS}; typed `string` because the wire may carry a newer one. */
  flags: string[];
  /** Whether prechecked applies. */
  prechecked: boolean;
  /** The evidence. */
  evidence: ProposalEvidence[];
  /** The id of the committed ref. */
  committedRefId: string | null;
  /**
   * #444, a `known` relation row only: the props committing it adds to the
   * live relation it matched (already spelled out in `display.subtitle`).
   * Optional so older payloads and fixtures still type-check.
   */
  fills?: Record<string, unknown> | null;
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The proposal detail.
 *
 * @stability experimental
 */
export interface ProposalDetail {
  /** The proposal. */
  proposal: ProposalSummary;
  /** The items. */
  items: ProposalItem[];
  /** The context. */
  context: {
    /** The system prompt. */
    systemPrompt: string;
    /** The user content. */
    userContent: string;
  } | null;
}

/**
 * The evidence span input the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type EvidenceSpanInput = ContractEvidenceSpanInput;

/**
 * The relink field the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type RelinkField = ContractRelinkField;

/**
 * #366's `patchItemSchema`.
 *
 * @stability experimental
 */
export interface PatchProposalItemInput {
  /** The decision. */
  decision: ProposalDecision;
  /** The edited payload. */
  editedPayload?: Record<string, unknown>;
  /** The id of the merge into. */
  mergeIntoId?: string;
  /** The relink to. */
  relinkTo?: {
    /** The field. */
    field: RelinkField;
    /** The target. */
    target: EndpointRef | null;
  };
  /** The distinct from. */
  distinctFrom?: string[];
  /** The evidence. */
  evidence?: {
    /** The add. */
    add?: EvidenceSpanInput[];
    /** The remove. */
    remove?: string[];
  };
}

/**
 * The patch proposal item result the API answers.
 *
 * @stability experimental
 */
export interface PatchProposalItemResult {
  /** The item. */
  item: ProposalItem;
  /** The counts. */
  counts: ProposalCounts;
}

/**
 * The bulk decision.
 *
 * @stability experimental
 */
export type BulkDecision = 'accept' | 'reject' | 'pending';

/**
 * The bulk skip reason the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type BulkSkipReason = ContractBulkSkipReason;

/**
 * The bulk decide result the API answers.
 *
 * @stability experimental
 */
export interface BulkDecideResult {
  /** The updated. */
  updated: number;
  /** The skipped. */
  skipped: Array<{
    /** The id of the item. */
    itemId: string;
    /** The reason. */
    reason: BulkSkipReason;
  }>;
  /** The counts. */
  counts: ProposalCounts;
}

/**
 * #366's `addItemSchema` (used by #368's "Add to graph").
 *
 * @stability experimental
 */
export interface AddProposalItemInput {
  /** The kind. */
  kind: 'entity' | 'relation' | 'item';
  /** The payload. */
  payload: Record<string, unknown>;
  /** The id of the existing entity. */
  existingEntityId?: string;
  /** The evidence. */
  evidence: EvidenceSpanInput[];
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The commit result the API answers.
 *
 * @stability experimental
 */
export interface CommitResult {
  /** The created. */
  created: {
    /** The entities. */
    entities: number;
    /** The relations. */
    relations: number;
    /** The items. */
    items: number;
  };
  /** The linked. */
  linked: number;
  /** The evidence added. */
  evidenceAdded: number;
  /** The closings applied. */
  closingsApplied: number;
  /** The closings skipped. */
  closingsSkipped: number;
  /** The superseded. */
  superseded: number;
  /** The aliases added. */
  aliasesAdded: number;
  /** The distinct pairs recorded. */
  distinctPairsRecorded: number;
  /** The skipped pending. */
  skippedPending: number;
  /** #444: props `known` relation rows added to the live relations they matched. */
  propsFilled?: number;
}

/**
 * The revert kept why.
 *
 * @stability experimental
 */
export type RevertKeptWhy = 'edited_since' | 'referenced_since' | 'merged_since' | 'evidence_since';

/**
 * The revert kept the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type RevertKept = ContractRevertKept;

/**
 * The revert result the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type RevertResult = ContractRevertResult;

/**
 * The list proposals params of the call.
 *
 * @stability experimental
 */
export interface ListProposalsParams {
  /** The status. */
  status?: ProposalStatus;
  /** The kind. */
  kind?: ProposalKind;
  /** The id of the note. */
  noteId?: string;
  /** The id of the transcript. */
  transcriptId?: string;
  /** The cursor. */
  cursor?: string;
  /** The limit. */
  limit?: number;
}

/**
 * #363's `requestExtractionSchema`.
 *
 * @stability experimental
 */
export interface RequestExtractionInput {
  /** The model. */
  model?: string;
  /** The user guidance. */
  userGuidance?: Partial<ProposalUserGuidance>;
}

/** #363's `extractionEstimateSchema`. */
/**
 * The extraction estimate the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type ExtractionEstimate = ContractExtractionEstimate;

/**
 * #363's `requestExtractionResponseSchema` (202).
 *
 * @stability experimental
 */
export interface RequestExtractionResult {
  /** The proposal. */
  proposal: {
    /** The id. */
    id: string;
    /** The id of the note. */
    noteId: string;
    /** The note version. */
    noteVersion: number;
    /** The status. */
    status: 'extracting';
    /** The model. */
    model: string;
    /** The id of the provider. */
    providerId: string;
    /** When the created happened, as an ISO timestamp. */
    createdAt: string;
  };
  /** The estimate. */
  estimate: ExtractionEstimate;
}

/**
 * #370's entity search row.
 *
 * @stability experimental
 */
export interface GraphEntitySearchResult {
  /** The id. */
  id: string;
  /** The type. */
  type: string;
  /** The label. */
  label: string;
  /** The aliases. */
  aliases: string[];
}

const proposalPath = (id: string) => `/graph/proposals/${encodeURIComponent(id)}`;

/**
 * `GET /api/graph/notes/:noteId/proposal` — the newest non-discarded proposal, or null.
 *
 * @stability experimental
 */
export async function getNoteProposal(host: KvoxWebHost, noteId: string): Promise<ProposalDetail | null> {
  const result = await kvoxGet<{ proposal: ProposalDetail | null }>(host, 
    `/graph/notes/${encodeURIComponent(noteId)}/proposal`,
  );
  return result.proposal;
}

/**
 * `GET /api/graph/proposals/:id[?include=context]`.
 *
 * @stability experimental
 */
export async function getProposal(
  host: KvoxWebHost,
  id: string,
  options: {
    /** Whether include context applies. */
    includeContext?: boolean;
  } = {},
): Promise<ProposalDetail> {
  const query = options.includeContext ? '?include=context' : '';
  return kvoxGet<ProposalDetail>(host, `${proposalPath(id)}${query}`);
}

/**
 * `GET /api/graph/proposals?status&kind&noteId&transcriptId&cursor&limit`.
 *
 * @stability experimental
 */
export async function listProposals(
  host: KvoxWebHost,
  params: ListProposalsParams = {},
): Promise<{
  /** The items. */
  items: ProposalSummary[];
  /** The next cursor. */
  nextCursor: string | null;
}> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return kvoxGet(host, `/graph/proposals${suffix ? `?${suffix}` : ''}`);
}

/**
 * Patches proposal item.
 *
 * @stability experimental
 */
export async function patchProposalItem(
  host: KvoxWebHost,
  proposalId: string,
  itemId: string,
  body: PatchProposalItemInput,
): Promise<PatchProposalItemResult> {
  return kvoxPatch<PatchProposalItemResult>(host, 
    `${proposalPath(proposalId)}/items/${encodeURIComponent(itemId)}`,
    body,
  );
}

/**
 * Applies in bulk decide proposal items.
 *
 * @stability experimental
 */
export async function bulkDecideProposalItems(
  host: KvoxWebHost,
  proposalId: string,
  body: {
    /** The item ids. */
    itemIds: string[];
    /** The decision. */
    decision: BulkDecision;
  },
): Promise<BulkDecideResult> {
  return kvoxPost<BulkDecideResult>(host, `${proposalPath(proposalId)}/items/bulk`, body);
}

/**
 * Adds proposal item.
 *
 * @stability experimental
 */
export async function addProposalItem(
  host: KvoxWebHost,
  proposalId: string,
  body: AddProposalItemInput,
): Promise<PatchProposalItemResult> {
  return kvoxPost<PatchProposalItemResult>(host, `${proposalPath(proposalId)}/items`, body);
}

/**
 * Commits proposal.
 *
 * @stability experimental
 */
export async function commitProposal(
  host: KvoxWebHost,
  id: string,
): Promise<{
  /** The proposal. */
  proposal: ProposalSummary;
  /** The result. */
  result: CommitResult;
}> {
  return kvoxPost(host, `${proposalPath(id)}/commit`, {});
}

/**
 * Discards proposal.
 *
 * @stability experimental
 */
export async function discardProposal(host: KvoxWebHost, id: string): Promise<{
  /** The proposal. */
  proposal: ProposalSummary;
}> {
  return kvoxPost(host, `${proposalPath(id)}/discard`, {});
}

/**
 * Reverts proposal.
 *
 * @stability experimental
 */
export async function revertProposal(
  host: KvoxWebHost,
  id: string,
  options: {
    /** Whether confirm partial applies. */
    confirmPartial: boolean;
  },
): Promise<{
  /** The proposal. */
  proposal: ProposalSummary;
  /** The result. */
  result: RevertResult;
}> {
  return kvoxPost(host, `${proposalPath(id)}/revert`, { confirmPartial: options.confirmPartial });
}

/**
 * `POST /api/graph/notes/:noteId/extract` — 202 with the extracting proposal.
 *
 * @stability experimental
 */
export async function requestExtraction(
  host: KvoxWebHost,
  noteId: string,
  body: RequestExtractionInput = {},
): Promise<RequestExtractionResult> {
  return kvoxPost<RequestExtractionResult>(host, 
    `/graph/notes/${encodeURIComponent(noteId)}/extract`,
    body,
  );
}

/**
 * `GET /api/graph/entities?type&q&limit` (#370) — the re-link search.
 *
 * @stability experimental
 */
export async function searchGraphEntities(
  host: KvoxWebHost,
  params: {
    /** The type. */
    type?: string;
    /** The q. */
    q: string;
    /** The limit. */
    limit?: number;
  },
): Promise<GraphEntitySearchResult[]> {
  const query = new URLSearchParams({ q: params.q, limit: String(params.limit ?? 10) });
  if (params.type) query.set('type', params.type);
  const result = await kvoxGet<{ items: GraphEntitySearchResult[]; nextCursor: string | null }>(
    host,
    `/graph/entities?${query.toString()}`,
  );
  return result.items;
}

/**
 * `GRAPH_CONFLICT_REASONS` (`packages/kvox-api/src/graph/graph-conflict-reasons.ts`)
 * plus the two #366 appends. Typed `| string` at the edge: a newer server may
 * send a reason this build does not know, and that must not be coerced.
 */
/**
 * The graph conflict reason the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphConflictReason = ContractGraphConflictReason;

/**
 * `details.reason` of a graph 409, like `noteConflictReason`.
 *
 * @stability experimental
 */
export function graphConflictReason(err: unknown): GraphConflictReason | null {
  if (!(err instanceof KvoxApiError) || err.status !== 409) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as GraphConflictReason) : null;
}

/**
 * `details.conflicts` of a 409 `revert_conflict`.
 *
 * @stability experimental
 */
export function revertConflictDetails(
  err: unknown,
): {
  /** The conflicts. */
  conflicts: RevertKept[];
  /** The revertible. */
  revertible: number;
} | null {
  if (graphConflictReason(err) !== 'revert_conflict') return null;
  const details = (err as KvoxApiError).details as { conflicts?: unknown; revertible?: unknown };
  return {
    conflicts: Array.isArray(details.conflicts) ? (details.conflicts as RevertKept[]) : [],
    revertible: typeof details.revertible === 'number' ? details.revertible : 0,
  };
}

/**
 * `details.issues` of a 400 — Zod issues, each with a `path`.
 *
 * @stability experimental
 */
export function graphValidationIssues(
  err: unknown,
): Array<{
  /** The path. */
  path: Array<string | number>;
  /** The message. */
  message: string;
}> {
  if (!(err instanceof KvoxApiError) || err.status !== 400) return [];
  const details = err.details as { issues?: unknown } | undefined;
  if (!details || !Array.isArray(details.issues)) return [];
  return details.issues
    .filter((issue): issue is { path?: unknown; message?: unknown } => typeof issue === 'object' && issue !== null)
    .map((issue) => ({
      path: Array.isArray(issue.path) ? (issue.path as Array<string | number>) : [],
      message: typeof issue.message === 'string' ? issue.message : 'Invalid value',
    }));
}

// =============================================================================
// Guide the graph, re-extract, add from a selection (#368, epic #346)
// =============================================================================

/** #363's `userGuidanceSchema`, as the extract dialog holds it. */
/**
 * The user guidance the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type UserGuidance = ContractUserGuidance;

/**
 * #363's `userGuidanceSchema` limits.
 *
 * @stability experimental
 */
export const GUIDANCE_MAX_PINNED = 50;
/**
 * The GUIDANCE MAX INSTRUCTIONS.
 *
 * @stability experimental
 */
export const GUIDANCE_MAX_INSTRUCTIONS = 2000;

/**
 * `GET /api/graph/extract/estimate?noteId&model` — what a run would cost; needs no key.
 *
 * @stability experimental
 */
export async function getExtractEstimate(host: KvoxWebHost, noteId: string, model?: string): Promise<ExtractionEstimate> {
  const query = new URLSearchParams({ noteId });
  if (model) query.set('model', model);
  return kvoxGet<ExtractionEstimate>(host, `/graph/extract/estimate?${query.toString()}`);
}

/**
 * What a 400 from `POST …/extract` (or the estimate) names, read off
 * `details`: unknown guidance types, pins that are not live entities, an
 * unpermitted model (#360's `details.reason`), or the token budget.
  *
 * @stability experimental
 */
export interface ExtractBadRequest {
  /** The unknown types. */
  unknownTypes: string[];
  /** The invalid pinned ids. */
  invalidPinnedIds: string[];
  /** Whether model not permitted applies. */
  modelNotPermitted: boolean;
  /** The budget. */
  budget: {
    /** The prompt tokens. */
    promptTokens: number;
    /** The available input tokens. */
    availableInputTokens: number;
    /** The model. */
    model: string | null;
  } | null;
}

/**
 * Extracts bad request.
 *
 * @stability experimental
 */
export function extractBadRequest(err: unknown): ExtractBadRequest | null {
  if (!(err instanceof KvoxApiError) || err.status !== 400) return null;
  const details = (typeof err.details === 'object' && err.details !== null ? err.details : {}) as Record<
    string,
    unknown
  >;
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
  const budget =
    typeof details.promptTokens === 'number' && typeof details.availableInputTokens === 'number'
      ? {
          promptTokens: details.promptTokens,
          availableInputTokens: details.availableInputTokens,
          model: typeof details.model === 'string' ? details.model : null,
        }
      : null;
  return {
    unknownTypes: strings(details.unknownTypes),
    invalidPinnedIds: strings(details.invalidPinnedIds),
    modelNotPermitted: details.reason === 'model_not_permitted',
    budget,
  };
}

// =============================================================================
// Whole-graph overview (#371) — used by #375's `/graph/overview`
// =============================================================================
//
// Mirrors `packages/kvox-api/src/graph/layout/dto/graph-overview.dto.ts` field for
// field. The server reads its latest STORED layout snapshot and joins labels
// live (spec §15, §22.3): a forgotten or merged entity is dropped server-side,
// so nothing here filters. Cluster ids are stable within ONE snapshot only —
// never persist one beyond the URL of the current view.

/**
 * #371's cap on `nodes` (the top N by degree).
 *
 * @stability experimental
 */
export const OVERVIEW_MAX_NODES = 5000;

/**
 * The graph overview member.
 *
 * @stability experimental
 */
export interface GraphOverviewMember {
  /** The id. */
  id: string;
  /** The label. */
  label: string;
  /** The type. */
  type: string;
  /** The degree. */
  degree: number;
}

/**
 * The graph overview cluster.
 *
 * @stability experimental
 */
export interface GraphOverviewCluster {
  /** `-1` is "Unconnected": every isolated entity, pooled. */
  id: number;
  /** Live label of `labelEntityId`; else `Cluster <id + 1>`; `Unconnected` for `-1`. */
  label: string;
  /** The id of the label entity. */
  labelEntityId: string | null;
  /** Members at the time of the snapshot. */
  size: number;
  /** The x. */
  x: number;
  /** The y. */
  y: number;
  /** The radius. */
  radius: number;
  /** The type counts. */
  typeCounts: Record<string, number>;
  /** Up to 8 members by degree. */
  memberSample: GraphOverviewMember[];
}

/**
 * The graph overview cluster edge.
 *
 * @stability experimental
 */
export interface GraphOverviewClusterEdge {
  /** The a. */
  a: number;
  /** The b. */
  b: number;
  /** The weight. */
  weight: number;
}

/**
 * The graph overview node.
 *
 * @stability experimental
 */
export interface GraphOverviewNode {
  /** The id. */
  id: string;
  /** The label. */
  label: string;
  /** The type. */
  type: string;
  /** The x. */
  x: number;
  /** The y. */
  y: number;
  /** The id of the cluster. */
  clusterId: number;
  /** The degree. */
  degree: number;
}

/**
 * The graph overview.
 *
 * @stability experimental
 */
export interface GraphOverview {
  /** `none`: no snapshot yet. */
  status: 'ready' | 'none';
  /** A `kg.graph_layout` job is pending or running for the caller. */
  pending: boolean;
  /** When the computed happened, as an ISO timestamp. */
  computedAt: string | null;
  /** The graph changed after the snapshot read it. Reported, never auto-refreshed. */
  stale: boolean;
  /** Past the layout ceiling: no clusters or positions. */
  tooLarge: boolean;
  /** The node count. */
  nodeCount: number;
  /** The edge count. */
  edgeCount: number;
  /** The clusters. */
  clusters: GraphOverviewCluster[];
  /** The cluster edges. */
  clusterEdges: GraphOverviewClusterEdge[];
  /** The nodes. */
  nodes: GraphOverviewNode[];
  /** Whether nodes truncated applies. */
  nodesTruncated: boolean;
}

/**
 * The graph overview refresh response the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphOverviewRefreshResponse = ContractGraphOverviewRefreshResponse;

/**
 * `GET /api/graph/overview` (`graph:read`) — never recomputes.
 *
 * @stability experimental
 */
export function getGraphOverview(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphOverview> {
  return kvoxGet<GraphOverview>(host, '/graph/overview', { signal });
}

/**
 * `POST /api/graph/overview/refresh` (`graph:write`) — 202, deduplicated.
 *
 * @stability experimental
 */
export function refreshGraphOverview(host: KvoxWebHost): Promise<GraphOverviewRefreshResponse> {
  return kvoxPost<GraphOverviewRefreshResponse>(host, '/graph/overview/refresh', {});
}

// =============================================================================
// Export (#386) — mirrors `packages/kvox-api/src/graph-rdf/export/dto/graph-export.dto.ts`
// =============================================================================

/**
 * The graph export format the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphExportFormat = ContractGraphExportFormat;
/**
 * The graph export status.
 *
 * @stability experimental
 */
export type GraphExportStatus = 'pending' | 'running' | 'ready' | 'failed';

/**
 * The graph export stats.
 *
 * @stability experimental
 */
export interface GraphExportStats {
  /** The entities. */
  entities?: number;
  /** The relations. */
  relations?: number;
  /** The items. */
  items?: number;
  /** The evidence. */
  evidence?: number;
  /** Sensitive person facts and attribute values left out — they never leave the deployment. */
  excludedSensitive?: number;
  /** The bytes. */
  bytes?: number;
}

/**
 * The graph export.
 *
 * @stability experimental
 */
export interface GraphExport {
  /** The id. */
  id: string;
  /** The format. */
  format: GraphExportFormat;
  /** The status. */
  status: GraphExportStatus;
  /** The ontology version. */
  ontologyVersion: string;
  /** The stats. */
  stats: GraphExportStats;
  /** The error message. */
  errorMessage: string | null;
  /** When the created happened, as an ISO timestamp. */
  createdAt: string;
  /** When the export and its file are deleted (7 days after the request). */
  expiresAt: string;
  /** A short-lived signed URL (the filename is signed in). Null unless ready. */
  downloadUrl: string | null;
  /** The filename. */
  filename: string;
}

/**
 * The create graph export response the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type CreateGraphExportResponse = ContractCreateGraphExportResponse;

/**
 * `POST /api/graph/exports` (`graph:read`) — 202 queued, 200 reused, 409 `graph_empty`.
 *
 * @stability experimental
 */
export function exportGraph(host: KvoxWebHost, format: GraphExportFormat): Promise<CreateGraphExportResponse> {
  return kvoxPost<CreateGraphExportResponse>(host, '/graph/exports', { format });
}

/**
 * `GET /api/graph/exports/:id` (`graph:read`) — 404 for a foreign or expired export.
 *
 * @stability experimental
 */
export function getGraphExport(host: KvoxWebHost, id: string, signal?: AbortSignal): Promise<GraphExport> {
  return kvoxGet<GraphExport>(host, `/graph/exports/${encodeURIComponent(id)}`, { signal });
}

/**
 * `GET /api/graph/exports` (`graph:read`) — the caller's unexpired exports, newest first.
 *
 * @stability experimental
 */
export async function listGraphExports(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphExport[]> {
  const response = await kvoxGet<{ exports: GraphExport[] }>(host, '/graph/exports', { signal });
  return response.exports;
}

// -----------------------------------------------------------------------------
// Graph import (#387, epic #349; spec §18.3)
// -----------------------------------------------------------------------------

/**
 * The graph import format the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphImportFormat = ContractGraphImportFormat;

/**
 * The graph import failure reason the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphImportFailureReason = ContractGraphImportFailureReason;

/**
 * What the file picker accepts — the extensions `POST /api/graph/imports` reads.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_ACCEPT = '.ttl,.jsonld,.json,.nq';

/**
 * The largest file an import accepts (20 MiB), checked client-side before the upload too.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * The graph import violation the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphImportViolation = ContractGraphImportViolation;

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The graph import offer.
 *
 * @stability experimental
 */
export interface GraphImportOffer {
  /** The id of the offer. */
  offerId: string;
  /** The iri. */
  iri: string;
  /** The label. */
  label: string | null;
  /** The count. */
  count: number;
  /** Entity/item type keys; `Assertion` when it sat on a relation (never acceptable). */
  subjectTypes: string[];
  /** The sample values. */
  sampleValues: string[];
  /** The suggested kind. */
  suggestedKind: string;
  /** The status. */
  status: 'offered' | 'accepted' | 'rejected';
}

/**
 * `proposal.stats` of a `kind: import` proposal. Only filename/format/bytes exist while extracting.
 *
 * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export interface GraphImportStats {
  /** The filename. */
  filename?: string;
  /** The format. */
  format?: GraphImportFormat;
  /** The bytes. */
  bytes?: number;
  /** The triples. */
  triples?: number;
  /** The source ontology version. */
  sourceOntologyVersion?: string | null;
  /** The migrated from. */
  migratedFrom?: string | null;
  /** The validation. */
  validation?: {
    /** Whether conforms applies. */
    conforms: boolean;
    /** The violations. */
    violations: GraphImportViolation[];
    /** The violation count. */
    violationCount: number;
  };
  /** The unknown properties. */
  unknownProperties?: GraphImportOffer[];
  /** The counts. */
  counts?: {
    /** The entities. */
    entities: number;
    /** The relations. */
    relations: number;
    /** The items. */
    items: number;
    /** The skipped sensitive. */
    skippedSensitive: number;
  };
  /** The failure reason. */
  failureReason?: GraphImportFailureReason | null;
}

/**
 * The import facts of a proposal summary (never throws; absent fields stay absent).
 *
 * @stability experimental
 */
export function importStatsOf(summary: ProposalSummary | null | undefined): GraphImportStats {
  return (summary?.stats ?? {}) as GraphImportStats;
}

/**
 * The create graph import response the API sends; a documented alias of the contract's type, so the
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type CreateGraphImportResponse = ContractCreateGraphImportResponse;

/**
 * `POST /api/graph/imports` (`graph:write`, multipart) — 202; 400/409/413 as `ApiError`.
 *
 * @stability experimental
 */
export function uploadGraphImport(host: KvoxWebHost, file: File): Promise<CreateGraphImportResponse> {
  const form = new FormData();
  form.append('file', file);
  return kvoxPostFormData<CreateGraphImportResponse>(host, '/graph/imports', form);
}

/**
 * The attribute offer result the API answers.
 *
 * @stability experimental
 */
export interface AttributeOfferResult {
  /** The offer. */
  offer: GraphImportOffer;
  /** The attribute defs. */
  attributeDefs: AttributeDef[];
  /** The rows updated. */
  rowsUpdated: number;
  /** The values dropped. */
  valuesDropped: number;
}

const offerPath = (proposalId: string, offerId: string, action: 'accept' | 'reject') =>
  `${proposalPath(proposalId)}/attribute-offers/${encodeURIComponent(offerId)}/${action}`;

/**
 * `POST /api/graph/proposals/:id/attribute-offers/:offerId/accept` (`graph:write`).
 *
 * @stability experimental
 */
export function acceptAttributeOffer(host: KvoxWebHost, proposalId: string, offerId: string, label?: string): Promise<AttributeOfferResult> {
  return kvoxPost<AttributeOfferResult>(host, offerPath(proposalId, offerId, 'accept'), label ? { label } : {});
}

/**
 * `POST /api/graph/proposals/:id/attribute-offers/:offerId/reject` (`graph:write`).
 *
 * @stability experimental
 */
export function rejectAttributeOffer(host: KvoxWebHost, proposalId: string, offerId: string): Promise<AttributeOfferResult> {
  return kvoxPost<AttributeOfferResult>(host, offerPath(proposalId, offerId, 'reject'));
}

// =============================================================================
// AI availability (what the extract dialog and the review sheet read)
// =============================================================================

/**
 * One enabled model, as `GET /api/ai-tasks/config` lists it.
 *
 * @stability experimental
 */
export interface GraphAiModel {
  /** The provider's own model id, for example `gpt-5.4`. */
  id: string;
  /** What a person reads in the picker. */
  label: string;
  /** Whether the model can return schema-constrained JSON, which extraction needs. */
  structuredOutput: boolean;
}

/**
 * The viewer's AI availability, narrowed to what the connected-knowledge UI
 * reads from `GET /api/ai-tasks/config`.
 *
 * @remarks
 * `keyConfigured` describes the viewer (they saved a provider key) and
 * `available` the deployment (AI is on and a model is permitted); they are
 * independent on purpose.
 *
 * @stability experimental
 */
export interface GraphAiConfig {
  /** The deployment permits AI at all. */
  available: boolean;
  /** The viewer has saved a provider key. */
  keyConfigured: boolean;
  /** The deployment switch for connected knowledge. */
  graphEnabled: boolean;
  /** The enabled models, ordered by id. */
  models: GraphAiModel[];
  /** The model to offer first, or `null`; never a model absent from `models`. */
  defaultModel: string | null;
  /** What each connected-knowledge task would run on for the viewer, keyed by task (`graph.extract`, ...). */
  taskModels?: Record<string, {
    /** The model. */
    model: string | null;
  }>;
}

/**
 * `GET /api/ai-tasks/config` — requires `notes:read`, which every seeded role holds.
 *
 * @param host - The host.
 * @param signal - Aborts the request.
 * @returns The viewer's AI availability.
 *
 * @stability experimental
 */
export function getGraphAiConfig(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphAiConfig> {
  return kvoxGet<GraphAiConfig>(host, '/ai-tasks/config', { signal });
}
