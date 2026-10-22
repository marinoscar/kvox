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
  TopicsPromoteRequestResponse as ContractTopicsPromoteRequestResponse,
  TopicsPromoteStatus as ContractTopicsPromoteStatus,
  GraphImportFormat as ContractGraphImportFormat,
  GraphImportFailureReason as ContractGraphImportFailureReason,
  GraphImportViolation as ContractGraphImportViolation,
  CreateGraphImportResponse as ContractCreateGraphImportResponse,
  CreateManualRelationDto as ContractCreateManualRelationDto,
  CreateManualRelationResponse as ContractCreateManualRelationResponse,
  RemoveManualRelationResponse as ContractRemoveManualRelationResponse,
  ManualRelationType as ContractManualRelationType,
} from '@marinoscar/kvox-contract/graph';
import { MANUAL_RELATION_TYPES as CONTRACT_MANUAL_RELATION_TYPES } from '@marinoscar/kvox-contract/graph';
import type { AttributeChoice as ContractAttributeChoice } from '@marinoscar/kvox-contract/ontology';

// =============================================================================
// Ontology (#354) — the payload every graph form is generated from
// =============================================================================

/**
 * The caller's effective ontology (`GET /api/graph/ontology`): the shipped schema merged with their own attribute definitions, from which every graph form is generated.
 *
 * @stability experimental
 */
export type GraphOntology = EffectiveSchemaPayload;
/**
 * One attribute of an entity or relation type in the effective ontology: key, label, kind, requiredness, choices and sensitivity.
 *
 * @stability experimental
 */
export type GraphAttributeDef = EffectiveAttributePayload;
/**
 * One entity type of the effective ontology, with its attributes, icon key and domain.
 *
 * @stability experimental
 */
export type GraphEntityTypeDef = EffectiveEntityTypePayload;
/**
 * One relation type of the effective ontology: its allowed source and target types and its own `props`.
 *
 * @stability experimental
 */
export type GraphRelationTypeDef = EffectiveRelationTypePayload;
/**
 * One element of the ontology's `entityTypes`; the name the Knowledge graph settings card (#369) uses for it.
 *
 * @stability experimental
 */
export type GraphEntityType = EffectiveSchemaPayload['entityTypes'][number];
/**
 * One attribute of a {@link GraphEntityType}.
 *
 * @stability experimental
 */
export type GraphAttribute = GraphEntityType['attributes'][number];
/**
 * One domain (a named group of entity types) of the effective ontology.
 *
 * @stability experimental
 */
export type GraphDomain = EffectiveSchemaPayload['domains'][number];

/**
 * Value type of an attribute: `text`, `number`, `date`, `boolean`, `select`, `multi_select`, `url` or `entity_ref`. Alias of the contract's `AttributeKind`.
 *
 * @stability experimental
 */
export type AttributeKind = ContractAttributeKind;
/**
 * How private an attribute's values are: `business`, `personal` or `sensitive`. Alias of the contract's `Sensitivity`.
 *
 * @stability experimental
 */
export type Sensitivity = ContractSensitivity;

/**
 * Fetches the caller's effective ontology (`GET /api/graph/ontology`).
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
 * How precisely a temporal bound is known: to the day, the month, the year, or not at all (`unknown`).
 *
 * @stability experimental
 */
export type DatePrecision = 'day' | 'month' | 'year' | 'unknown';
/**
 * The kind of a knowledge item hanging off entities: a commitment, a decision, a risk, a claim or a fact about a person.
 *
 * @stability experimental
 */
export type GraphItemKind = 'commitment' | 'decision' | 'claim' | 'person_fact' | 'risk';

/** `entityRef` in both #370 and #372. */
/**
 * A compact `{ id, label, type }` reference to an entity, as read responses embed it. Alias of the contract's `GraphEntityRef`.
 *
 * @stability experimental
 */
export type GraphEntityRef = ContractGraphEntityRef;

// =============================================================================
// Entity index + detail (#370)
// =============================================================================

/**
 * One row of the entity index (`GET /api/graph/entities`).
 *
 * @stability experimental
 */
export interface GraphEntitySummary {
  /** Entity id (UUID). */
  id: string;
  /** Entity type key from the effective ontology, e.g. `Person`. */
  type: string;
  /** Display name. */
  label: string;
  /** Up to five other names, oldest first; the label itself is not repeated. */
  aliases: string[];
  /** Number of notes and transcripts linked to this entity. */
  mentionCount: number;
  /** ISO 8601 date of the latest Meeting this entity has evidence in, or `null` when it has none. */
  lastSeenAt: string | null;
  /** The speaker ids identified as this Person in the requested transcript. Present only when the list was filtered with `transcriptId`. */
  speakerIds?: string[];
}

/**
 * Filters and paging for {@link listGraphEntities}.
 *
 * @stability experimental
 */
export interface GraphEntityListParams {
  /** Entity type keys to keep (comma-joined on the wire). Omitted means every type. */
  type?: readonly string[];
  /** Fuzzy search over labels and aliases. Returns the top `limit` by similarity and no further pages. */
  q?: string;
  /** Only the Persons identified as a speaker in this transcript. */
  transcriptId?: string;
  /** `updated` orders by most recent change, `viewed` by the entities the caller viewed last; ignored when `q` is set. */
  sort?: 'updated' | 'viewed';
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** Page size (the API allows 1 to 50, default 25). */
  limit?: number;
}

/**
 * One page of the entity index.
 *
 * @stability experimental
 */
export interface GraphEntityListResponse {
  /** The entities on this page. */
  items: GraphEntitySummary[];
  /** Always `null` when `q` is set (top-`limit` by similarity). */
  nextCursor: string | null;
}

/**
 * Where an entity alias came from: typed by the user, found by extraction, set by naming a speaker, or imported.
 *
 * @stability experimental
 */
export type GraphAliasSource = 'user' | 'extraction' | 'speaker_naming' | 'import';

/**
 * One alternative name of an entity.
 *
 * @stability experimental
 */
export interface GraphEntityAlias {
  /** Alias id (UUID), used to remove it through {@link GraphEntityPatch}. */
  id: string;
  /** The name as written. */
  alias: string;
  /** How the alias came to exist. */
  source: GraphAliasSource;
}

/**
 * How much hangs off an entity; the numbers behind the tabs of its page.
 *
 * @stability experimental
 */
export interface GraphEntityCounts {
  /** Relations the entity takes part in. */
  relations: number;
  /** Notes and transcripts that mention the entity. */
  mentions: number;
  /** Evidence links (quoted source spans) attached to the entity. */
  evidence: number;
  /** Knowledge items attached to the entity, counted per kind. */
  items: {
    /** Commitments about or owned by the entity. */
    commitment: number;
    /** Decisions about the entity. */
    decision: number;
    /** Claims about the entity. */
    claim: number;
    /** Facts about a person. */
    person_fact: number;
    /** Risks, issues and blockers about the entity. */
    risk: number;
  };
  /** How many of the commitments are still open. */
  openCommitments: number;
  /** Readable relations per relation type key, both directions; feeds the explorer's Expand menu. Absent from an older API. */
  relationsByType?: Record<string, number>;
  /** The same relations per entity type of the entity at the other end. Absent from an older API. */
  relationsByNeighborType?: Record<string, number>;
}

/**
 * One entity of the caller's graph with counts for its page (`GET /api/graph/entities/:id`).
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphEntityDetail = ContractGraphEntityDetail;

// =============================================================================
// Graph slice (#370) — neighbourhood + expand
// =============================================================================

/**
 * One node of a graph slice: an entity or a knowledge item, with its degree for sizing.
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type GraphNode = ContractGraphNode;

/**
 * The period an edge is valid, as a half-open range.
 *
 * @stability experimental
 */
export interface GraphValidRange {
  /** Inclusive start as an ISO 8601 instant, or `null` when unbounded. */
  from: string | null;
  /** Exclusive end as an ISO 8601 instant, or `null` when unbounded. */
  to: string | null;
  /** How precisely the bounds are known. */
  precision: DatePrecision;
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * One edge of a graph slice: a stored relation, or a `virtual` one derived from an item column.
 *
 * @stability experimental
 */
export interface GraphEdge {
  /** `kg_relations.id`, or `virt:<itemId>:<TYPE>` for column-derived edges. */
  id: string;
  /** Relation type key, e.g. `WORKS_FOR`. */
  type: string;
  /** Stored direction, never inverted. */
  source: string;
  /** Id of the node the edge points to. */
  target: string;
  /** When the relation holds, or `null` for a non-temporal relation. */
  valid: GraphValidRange | null;
  /** Extraction confidence from 0 to 1, or `null` when the relation was not extracted (manual or imported). */
  confidence: number | null;
  /** `true` for an edge derived from an item column rather than a stored relation. */
  virtual: boolean;
  /**
   * The relation's own attribute values, keyed by prop key — e.g. `HAS_ROLE`
   * `{ title, businessUnit }` (#440/#442). Only declared, non-deprecated,
   * non-sensitive, non-null props, in declaration order; `{}` otherwise.
   * Optional here because an older API omits it — read it as `{}` when absent.
   */
  props?: Record<string, unknown>;
  /**
   * Evidence rows behind the edge (a virtual item edge carries the item's
   * count). Optional: an older API omits it.
   */
  evidenceCount?: number;
  /** ISO instant of the latest evidence behind the edge, or `null` when none; optional like {@link GraphEdge.evidenceCount}. */
  lastEvidenceAt?: string | null;
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * The subgraph the API returns for a neighbourhood or an expand call: nodes, edges and whether it was cut off.
 *
 * @stability experimental
 */
export interface GraphSlice {
  /** Ids of the nodes the slice was grown from, in request order. */
  seedIds: string[];
  /** The instant the slice was evaluated at, as an ISO 8601 string. */
  asOf: string;
  /** Entities and items in the slice, seeds included. */
  nodes: GraphNode[];
  /** Relations between the slice's nodes, in their stored direction. */
  edges: GraphEdge[];
  /** `true` when more nodes were reachable than `cap`; the slice is then partial. */
  truncated: boolean;
  /** The node cap the API applied to this slice. */
  cap: number;
}

/**
 * Options for {@link getEntityNeighborhood}.
 *
 * @stability experimental
 */
export interface GraphNeighborhoodParams {
  /** How many relation hops to walk from the seed: 1 (default) or 2. */
  hops?: 1 | 2;
  /** Entity types or item kinds to keep. The seed itself is always kept. */
  types?: readonly string[];
  /** Relation types to walk along. Omitted means all. */
  relationTypes?: readonly string[];
  /** Evaluate the graph as of this date (`YYYY-MM-DD`) or ISO 8601 instant. Omitted means now. */
  asOf?: string;
  /** Maximum nodes to return (the API default is 150). */
  limit?: number;
}

// =============================================================================
// Timeline + mentions (#370)
// =============================================================================

/**
 * The knowledge item (commitment, decision, claim or person fact) behind an item timeline row.
 *
 * @stability experimental
 */
export interface TimelineItem {
  /** Item id (UUID). */
  id: string;
  /** Which kind of item this is. */
  kind: GraphItemKind;
  /** Short title, or `null` when the item has only a statement. */
  title: string | null;
  /** The item's full statement. */
  statement: string;
  /** Item status (e.g. `open`), or `null` for kinds without a status. */
  status: string | null;
  /** ISO 8601 due date of a commitment, or `null` when it has none. */
  dueAt: string | null;
  /** The person who owns a commitment, or `null` when unknown or not applicable. */
  ownerPerson: GraphEntityRef | null;
  /** The other party of a commitment, or `null` when none was recorded. */
  counterparty: GraphEntityRef | null;
  /** Sensitivity of a person fact; `null` for other kinds. `sensitive` items are only returned on request. */
  sensitivity: 'business' | 'personal' | 'sensitive' | null;
  /** `true` when a newer item replaced this one. */
  superseded: boolean;
  /** Id of the item that replaced this one, or `null` when it is current. */
  supersededById: string | null;
}

/**
 * The relation behind a relation-started or relation-ended timeline row, seen from the page's entity.
 *
 * @stability experimental
 */
export interface TimelineRelation {
  /** Relation id (UUID). */
  id: string;
  /** Relation type key. */
  type: string;
  /** `out` when the page's entity is the source of the relation, `in` when it is the target. */
  direction: 'out' | 'in';
  /** The entity at the other end. */
  other: GraphEntityRef;
  /** When the relation holds, or `null` when it is not temporal. */
  valid: GraphValidRange | null;
}

/**
 * One row of an entity's timeline: an item, a relation starting or ending, or a meeting, with its citations. Alias of the contract's `TimelineEvent`.
 *
 * @stability experimental
 */
export type TimelineEvent = ContractTimelineEvent;

/**
 * Options for {@link getEntityTimeline}.
 *
 * @stability experimental
 */
export interface TimelineParams {
  /** Evaluate the timeline as of this date (`YYYY-MM-DD`) or ISO 8601 instant. Omitted means now. */
  asOf?: string;
  /** Subset of timeline kinds to keep (`commitment`, `decision`, `claim`, `person_fact`, `relation`, `meeting`). */
  kinds?: readonly string[];
  /** Include `sensitive` person facts; the API default is `false`. */
  includeSensitive?: boolean;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** Page size (the API allows 1 to 50, default 25). */
  limit?: number;
}

/**
 * One page of an entity's timeline with the instant it was evaluated at. Alias of the contract's `TimelineResponse`.
 *
 * @stability experimental
 */
export type TimelineResponse = ContractTimelineResponse;

/**
 * One note or transcript that mentions an entity.
 *
 * @stability experimental
 */
export interface EntityMention {
  /** Whether the mentioning document is a note or a transcript. */
  kind: 'note' | 'transcript';
  /** Note or transcript id (UUID). */
  id: string;
  /** Title, or `null` when the document is no longer available to the caller. */
  title: string | null;
  /** ISO 8601 date the document is about (e.g. a meeting date), or `null` when unknown. */
  occurredAt: string | null;
  /** `false` when the document was deleted or the caller can no longer view it. */
  available: boolean;
}

/**
 * One page of the documents that mention an entity.
 *
 * @stability experimental
 */
export interface EntityMentionsResponse {
  /** The mentions on this page. */
  items: EntityMention[];
  /** Cursor for the next page, or `null` on the last one. */
  nextCursor: string | null;
}

// =============================================================================
// Evidence links (#370)
// =============================================================================

/**
 * A citation anchored in a transcript segment.
 *
 * @stability experimental
 */
export interface SegmentEvidenceSource {
  /** Discriminator for the transcript-segment source. */
  kind: 'segment';
  /** Transcript id, or `null` when the anchor no longer carries one. */
  transcriptId: string | null;
  /** Transcript title, or `null` when the transcript is unavailable to the caller. */
  transcriptTitle: string | null;
  /** Id of the anchored segment, or `null` when none. */
  segmentId: string | null;
  /** Revision of the segment at the moment the quote was anchored. */
  segmentRev: number | null;
  /** The segment's revision now, or `null` when it cannot be looked up. */
  currentSegmentRev: number | null;
  /** Start of the quoted moment, in milliseconds from the start of the recording. */
  startMs: number | null;
  /** End of the quoted moment, in milliseconds from the start of the recording. */
  endMs: number | null;
  /** `true` when the segment was edited since the quote was anchored (`currentSegmentRev` differs from `segmentRev`). Always `false` when unavailable. */
  textChanged: boolean;
  /** `false` when the transcript was deleted or the caller can no longer view it; there is then no link, but the quote is still returned. */
  available: boolean;
  /** App link that opens the transcript at the quoted moment, or `null` when unavailable. */
  href: string | null;
  /** Whether the cited transcript has a recording to play (#604); `false` for an imported transcript. Absent from an older server: treat `undefined` as `true`. */
  hasAudio?: boolean;
}

/**
 * A citation anchored in a note version.
 *
 * @stability experimental
 */
export interface NoteEvidenceSource {
  /** Discriminator for the note source. */
  kind: 'note';
  /** Note id, or `null` when the anchor no longer carries one. */
  noteId: string | null;
  /** Note title, or `null` when the note is unavailable to the caller. */
  noteTitle: string | null;
  /** Note version the quote was drawn from. */
  noteVersion: number | null;
  /** The note's current version, or `null` when it cannot be looked up. */
  currentNoteVersion: number | null;
  /** Offset of the first quoted character in that version's text. */
  charStart: number | null;
  /** Offset just past the last quoted character in that version's text. */
  charEnd: number | null;
  /** `true` when the note has a newer version than the one quoted. Always `false` when unavailable. */
  versionChanged: boolean;
  /** `false` when the note was deleted or the caller can no longer view it; there is then no link, but the quote is still returned. */
  available: boolean;
  /** App link that opens the exact note version, or `null` when unavailable. */
  href: string | null;
}

/**
 * A citation that came from an imported graph file.
 *
 * @stability experimental
 */
export interface ImportEvidenceSource {
  /** Discriminator for the import source. */
  kind: 'import';
  /** Id of the uploaded import object, or `null` when the anchor no longer carries one. */
  importObjectId: string | null;
  /** IRI of the source record in the imported file, when it had one. */
  sourceIri: string | null;
  /** `true` only while the caller still owns the uploaded import object. */
  available: boolean;
  /** Always `null`: an import has no page to open. */
  href: null;
}

/**
 * A citation the owner made by hand on an entity page (#586): a manager,
 * employer or role set manually. The quote says what was set.
 *
 * @stability experimental
 */
export interface ManualEvidenceSource {
  /** Discriminator for a manual source. */
  kind: 'manual';
  /** Always `true`: the owner is the source. */
  available: true;
  /** Always `null`: there is no document to open. */
  href: null;
}

/**
 * Where a citation comes from, discriminated by `kind`: a transcript segment, a note version, an import, or the owner by hand.
 *
 * @stability experimental
 */
export type EvidenceSource = SegmentEvidenceSource | NoteEvidenceSource | ImportEvidenceSource | ManualEvidenceSource;

/**
 * One citation resolved to a link: the quote, its source and whether the source is still available. Alias of the contract's `EvidenceLink`.
 *
 * @stability experimental
 */
export type EvidenceLink = ContractEvidenceLink;

/**
 * The API's cap on one `GET /api/graph/evidence?ids=` call: ids beyond it are rejected.
 *
 * @stability experimental
 */
export const EVIDENCE_BATCH_MAX = 50;

// =============================================================================
// Brief (#372)
// =============================================================================

/**
 * One sentence of an entity digest with the ids of the evidence that supports it. Alias of the contract's `CitedStatement`.
 *
 * @stability experimental
 */
export type CitedStatement = ContractCitedStatement;

/**
 * One item (commitment, decision, claim or person fact) listed in a brief section, with its citations. Alias of the contract's `BriefEntry`.
 *
 * @stability experimental
 */
export type BriefEntry = ContractBriefEntry;

/**
 * A relation between people that started or ended inside the brief window. Alias of the contract's `PeopleChange`.
 *
 * @stability experimental
 */
export type PeopleChange = ContractPeopleChange;

/**
 * A note or transcript related to the entity, with a search snippet. Alias of the contract's `RelatedSource`.
 *
 * @stability experimental
 */
export type RelatedSource = ContractRelatedSource;

/**
 * Why a stale digest is not being refreshed: `graph_disabled`, `ai_not_configured`, `ai_key_missing` or `model_lacks_capability`. Alias of the contract's `DigestUnavailableReason`.
 *
 * @stability experimental
 */
export type DigestUnavailableReason = ContractDigestUnavailableReason;

/**
 * The AI-written summary of an entity, as stored by the `kg.entity_digest` job.
 *
 * @stability experimental
 */
export interface EntityDigest {
  /** The summary, one cited statement at a time. */
  statements: CitedStatement[];
  /** ISO 8601 instant up to which the digest covers changes, or `null` when unknown. */
  coversUntil: string | null;
  /** ISO 8601 instant the job produced the digest. */
  generatedAt: string;
  /** Model that wrote the digest. */
  model: string;
}

/**
 * An entity's brief (`GET /api/graph/entities/:id/brief`): what changed, open commitments and related sources, plus the cached AI digest. Reading it never calls a model.
 *
 * @stability experimental
 */
export interface EntityBrief {
  /** The entity the brief is about. */
  entity: GraphEntityRef;
  /** The time window the "what changed" sections cover. */
  window: {
    /** Start of the window, or `null` when none could be determined. */
    since: string | null;
    /** Where `since` came from: the request (`query`), the caller's last visit (`last_viewed`), the digest's coverage (`digest`) or the default of 30 days (`default`). */
    sinceSource: 'query' | 'last_viewed' | 'digest' | 'default';
    /** The instant the brief was evaluated at, as an ISO 8601 string. */
    asOf: string;
    /** ISO 8601 instant the caller last opened this brief, or `null` if never. */
    lastViewedAt: string | null;
  };
  /** The latest stored digest; `null` when none exists yet, or when the brief was requested with `asOf`. */
  digest: EntityDigest | null;
  /** `true` when there is something to summarize but no digest, or the digest predates the newest change. */
  digestStale: boolean;
  /** `true` while a `kg.entity_digest` job for this entity is queued or running. */
  digestPending: boolean;
  /** Why a stale digest is not being refreshed (missing AI configuration or key, graph disabled, model without the capability), or `null`. */
  digestUnavailable: DigestUnavailableReason | null;
  /** The brief's lists, each already capped by the API. */
  sections: {
    /** Changes inside the window. */
    whatChanged: BriefEntry[];
    /** Decisions about the entity. */
    decisions: BriefEntry[];
    /** Commitments that are still open, split by who owes them. */
    openCommitments: {
      /** Commitments owed by the other party. */
      theirs: BriefEntry[];
      /** Commitments owed by the caller. */
      yours: BriefEntry[];
    };
    /** Claims and risks recorded for the entity. */
    risksClaims: BriefEntry[];
    /** Open risks, issues and blockers about a project, product or organization, highest severity first. Absent when there are none. */
    openRisks?: BriefEntry[];
    /** Relations between people and others (for example a role) that started or ended. */
    peopleChanges: PeopleChange[];
  };
  /** Notes and transcripts related to the entity, found by search. */
  related: RelatedSource[];
}

/**
 * Options for {@link getEntityBrief}.
 *
 * @stability experimental
 */
export interface EntityBriefParams {
  /** Start of the "what changed" window (`YYYY-MM-DD` or ISO 8601). Omitted means the caller's last visit, else the digest's coverage, else 30 days before `asOf`. */
  since?: string;
  /** Evaluate the brief as of this date or instant. With it, `digest` is `null`, nothing is enqueued and the last-viewed time is not moved. */
  asOf?: string;
  /** Record this visit as "last looked". The API default is `true`; ignored with `asOf`. */
  markViewed?: boolean;
}

// =============================================================================
// Writes (#355, #357)
// =============================================================================

/**
 * Body of the manual entity edit (`PATCH /api/graph/entities/:id`). `type` is deliberately absent: a type changes only through a proposal.
 *
 * @stability experimental
 */
export interface GraphEntityPatch {
  /** New display name; the old one is kept as an alias. */
  label?: string;
  /** Merge: `key → value` sets, `key → null` clears, absent keys unchanged. */
  props?: Record<string, unknown>;
  /** Other names to add. One that normalizes to an existing alias is ignored. */
  addAliases?: string[];
  /** Ids of aliases to remove. */
  removeAliasIds?: string[];
}

/**
 * The entity as `PATCH /api/graph/entities/:id` returns it (`graphEntitySchema`); not the same shape as {@link GraphEntityDetail}, it has no counts.
 *
 * @stability experimental
 */
export interface GraphEntityRecord {
  /** Entity id (UUID). */
  id: string;
  /** Entity type key. */
  type: string;
  /** Display name. */
  label: string;
  /** Attribute values, keyed by attribute key. */
  props: Record<string, unknown>;
  /** Review state of the entity (e.g. `accepted` or `edited`). */
  reviewStatus: string;
  /** Id of the entity this one was merged into, or `null` when it is live. */
  mergedIntoId: string | null;
  /** ISO 8601 instant for an event-like entity (a Meeting), or `null`. */
  occurredAt: string | null;
  /** Version of the ontology the entity was written under. */
  ontologyVersion: string;
  /** Every alias of the entity, with its normalized form. */
  aliases: Array<GraphEntityAlias & {
    /** The comparison form every exact-match lookup reads. */
    normalized: string;
    /** ISO 8601 instant the alias was created. */
    createdAt: string;
  }>;
  /** ISO 8601 instant the entity was created. */
  createdAt: string;
  /** ISO 8601 instant the entity was last changed. */
  updatedAt: string;
}

/**
 * The exact text a caller must send to confirm forgetting an entity (`POST /api/graph/entities/:id/forget`).
 *
 * @stability experimental
 */
export const FORGET_CONFIRMATION = 'FORGET';

/**
 * The queued deletion of a forgotten person: the `kg.purge` job id, the entity id and `pending` or `running`. Alias of the contract's `ForgetEntityResponse`.
 *
 * @stability experimental
 */
export type ForgetEntityResponse = ContractForgetEntityResponse;

// =============================================================================
// Query-string helper
// =============================================================================

/**
 * A query-string value {@link buildGraphQuery} accepts; arrays are comma-joined and `undefined`, `null` and empty values are dropped.
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
 * Lists graph entities (`GET /api/graph/entities`), one page at a time.
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
 * Fetches one entity with its counts (`GET /api/graph/entities/:id`).
 *
 * @stability experimental
 */
export function getGraphEntity(host: KvoxWebHost, id: string, signal?: AbortSignal): Promise<GraphEntityDetail> {
  return kvoxGet<GraphEntityDetail>(host, `/graph/entities/${enc(id)}`, { signal });
}

/**
 * Fetches a page of an entity's timeline (`GET /api/graph/entities/:id/timeline`).
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
 * Fetches a page of the notes and transcripts that mention an entity (`GET /api/graph/entities/:id/mentions`).
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
 * Fetches the subgraph around an entity (`GET /api/graph/entities/:id/neighborhood`), up to two hops out.
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
 * The most nodes one slice or the explorer may hold (§22.2); the API refuses a larger `limit` or `cap`.
 *
 * @stability experimental
 */
export const GRAPH_NODE_CAP = 300;
/**
 * The most seed ids one {@link expandGraph} call accepts.
 *
 * @stability experimental
 */
export const GRAPH_EXPAND_MAX_SEEDS = 50;

/**
 * Request for {@link expandGraph}.
 *
 * @stability experimental
 */
export interface GraphExpandParams {
  /** 1 to 50 entity or item ids to expand from. One the caller cannot read fails the whole call with a 404. */
  nodeIds: readonly string[];
  /** Entity types and item kinds expansion may add; the seeds are always kept. Omitted means no restriction. */
  types?: readonly string[];
  /** Relation types expansion may walk along. Omitted means all. */
  relationTypes?: readonly string[];
  /** Evaluate the graph as of this date (`YYYY-MM-DD`) or ISO 8601 instant. Omitted means now. */
  asOf?: string;
  /** Most nodes the returned slice may hold, 1 to {@link GRAPH_NODE_CAP}. */
  cap: number;
}

/**
 * Expands one hop out from each seed node into a single slice (`POST /api/graph/explore/expand`).
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
 * The most paths one {@link getGraphPaths} call may ask for.
 *
 * @stability experimental
 */
export const GRAPH_PATHS_MAX_K = 5;
/**
 * The longest path, in edges, one {@link getGraphPaths} call may ask for.
 *
 * @stability experimental
 */
export const GRAPH_PATHS_MAX_HOPS = 5;

/**
 * Options for {@link getGraphPaths}.
 *
 * @stability experimental
 */
export interface GraphPathsParams {
  /** Id of the entity (or item) the paths start at. */
  from: string;
  /** Id of the entity (or item) the paths end at; must differ from `from`. */
  to: string;
  /** How many distinct paths to return, 1 to {@link GRAPH_PATHS_MAX_K}. The API default is 3. */
  k?: number;
  /** The longest path to look for, in edges, 1 to {@link GRAPH_PATHS_MAX_HOPS}. The API default is 4. */
  maxHops?: number;
  /** Entity types and item kinds a path may pass through. The endpoints are always kept. Omitted means no restriction. */
  types?: readonly string[];
  /** Relation types a path may follow. Omitted means all. */
  relationTypes?: readonly string[];
  /** Evaluate the graph as of this date (`YYYY-MM-DD`) or ISO 8601 instant. Omitted means now. */
  asOf?: string;
}

/**
 * One path between two nodes, as ids into {@link GraphPathsResponse.slice}.
 *
 * @stability experimental
 */
export interface GraphPath {
  /** The nodes in walking order, `from` first and `to` last. */
  nodeIds: string[];
  /** The edge between each consecutive pair of nodes, by id in the slice. An edge keeps its stored direction. */
  edgeIds: string[];
  /** Number of edges; `edgeIds.length`. */
  hops: number;
  /** Mean `log(1 + evidenceCount)` over the edges, discounted for passing through high-degree hubs. Higher is stronger. */
  score: number;
}

/**
 * The answer of {@link getGraphPaths}.
 *
 * @stability experimental
 */
export interface GraphPathsResponse {
  /** The start node, as requested. */
  from: string;
  /** The end node, as requested. */
  to: string;
  /** The `as_of` instant that was applied, or `null` when the request had none (now). */
  asOf: string | null;
  /** The best paths first. Empty when nothing connects the two within `maxHops`. */
  paths: GraphPath[];
  /** The union of the nodes and edges of every returned path; the two endpoints are always in it. */
  slice: GraphSlice;
  /** `true` when a per-hop cap was hit, so a stronger path than those returned may exist. */
  truncated: boolean;
}

/**
 * Fetches the top evidence-weighted paths between two nodes (`GET /api/graph/paths`).
 * `asOf` is sent as the API's `as_of`; an absent option is omitted so the API default applies.
 * A node the caller cannot read rejects with a 404; a search that takes too long, with a 503 `graph_query_timeout`.
 *
 * @stability experimental
 */
export function getGraphPaths(
  host: KvoxWebHost,
  params: GraphPathsParams,
  signal?: AbortSignal,
): Promise<GraphPathsResponse> {
  const query = buildGraphQuery({
    from: params.from,
    to: params.to,
    k: params.k,
    maxHops: params.maxHops,
    types: params.types,
    relationTypes: params.relationTypes,
    as_of: params.asOf,
  });
  return kvoxGet<GraphPathsResponse>(host, `/graph/paths${query}`, { signal });
}

/**
 * Fetches one citation resolved to a link (`GET /api/graph/evidence/:id`).
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
 * What {@link getSubjectEvidence} can be asked about.
 *
 * @stability experimental
 */
export type EvidenceSubjectKind = 'entity' | 'relation' | 'item';

/**
 * Fetches the citations that support one entity, relation or item, newest source first and at most 50 (`GET /api/graph/evidence/by-subject`). The API answers 404 for a subject that is not the caller's, and for a sensitive personal fact; callers also never ask about a person fact.
 *
 * @stability experimental
 */
export async function getSubjectEvidence(
  host: KvoxWebHost,
  kind: EvidenceSubjectKind,
  id: string,
  signal?: AbortSignal,
): Promise<EvidenceLink[]> {
  const query = buildGraphQuery({ kind, id });
  const page = await kvoxGet<{ items: EvidenceLink[] }>(host, `/graph/evidence/by-subject${query}`, { signal });
  return page.items;
}

/**
 * Fetches an entity's brief (`GET /api/graph/entities/:id/brief`): its sections and stored digest. Never calls a model and never answers 409.
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
 * Edits an entity manually (`PATCH /api/graph/entities/:id`): label, attribute values and aliases. A type change is not possible here.
 *
 * @stability experimental
 */
export function updateGraphEntity(host: KvoxWebHost, id: string, body: GraphEntityPatch): Promise<GraphEntityRecord> {
  return kvoxPatch<GraphEntityRecord>(host, `/graph/entities/${enc(id)}`, body);
}

/**
 * Asks for a person to be forgotten (`POST /api/graph/entities/:id/forget`), sending the required {@link FORGET_CONFIRMATION}. Queues a `kg.purge` job; the person stays visible until it completes.
 *
 * @stability experimental
 */
export function forgetGraphEntity(host: KvoxWebHost, id: string): Promise<ForgetEntityResponse> {
  return kvoxPost<ForgetEntityResponse>(host, `/graph/entities/${enc(id)}/forget`, {
    confirmation: FORGET_CONFIRMATION,
  });
}

// =============================================================================
// Manual relation edits (#586)
// =============================================================================

/**
 * The relation types a manual relation edit writes from a Person: `REPORTS_TO`, `WORKS_FOR`, `HAS_ROLE`.
 *
 * @stability experimental
 */
export const MANUAL_RELATION_TYPES = CONTRACT_MANUAL_RELATION_TYPES;

/**
 * One of {@link MANUAL_RELATION_TYPES}.
 *
 * @stability experimental
 */
export type ManualRelationType = ContractManualRelationType;

/**
 * The body of `POST /api/graph/entities/:id/relations`: `{ type, toId, props?, validFrom? }` (`props` for `HAS_ROLE` only, with a `title`).
 *
 * @stability experimental
 */
export type SetEntityRelationBody = ContractCreateManualRelationDto;

/**
 * What a manual relation edit wrote: the relation, whether it is new, the citation added, the edges it closed and soft flags.
 *
 * @stability experimental
 */
export type SetEntityRelationResult = ContractCreateManualRelationResponse;

/**
 * A removed (retracted) relation and the edges it reopened.
 *
 * @stability experimental
 */
export type RemoveEntityRelationResult = ContractRemoveManualRelationResponse;

/**
 * Sets a Person's manager, employer or role by hand (`POST /api/graph/entities/:id/relations`). A still-open edge of the same type is closed at the new start; the relation is cited "Set by hand".
 *
 * @stability experimental
 */
export function setEntityRelation(host: KvoxWebHost, entityId: string, body: SetEntityRelationBody): Promise<SetEntityRelationResult> {
  return kvoxPost<SetEntityRelationResult>(host, `/graph/entities/${enc(entityId)}/relations`, body);
}

/**
 * Removes a wrong manager, employer or role (`DELETE /api/graph/entities/:id/relations/:relationId`): a correction, the relation is kept as `rejected`.
 *
 * @stability experimental
 */
export function removeEntityRelation(host: KvoxWebHost, entityId: string, relationId: string): Promise<RemoveEntityRelationResult> {
  return kvoxDelete<RemoveEntityRelationResult>(host, `/graph/entities/${enc(entityId)}/relations/${enc(relationId)}`);
}

// =============================================================================
// Attribute definitions (#355, used by #369's settings card)
// =============================================================================

/**
 * One permitted value of a `select` or `multi_select` attribute: a permanent stored `value` and a renameable `label`.
 * wire shape has one definition.
 *
 * @stability experimental
 */
export type AttributeChoice = ContractAttributeChoice;

/**
 * Kind-specific options of an attribute definition; sent only for `select`, `multi_select` and `entity_ref` kinds.
 *
 * @stability experimental
 */
export interface AttributeDefOptions {
  /** `select` and `multi_select` only: the permitted values, in display order. Choices may be added or relabelled, never removed. */
  choices?: AttributeChoice[];
  /** `entity_ref` only: the entity type keys a reference may point at. */
  targetTypes?: string[];
}

/**
 * One of the caller's own attribute definitions (`GraphAttributeDefDto`), field for field.
 *
 * @stability experimental
 */
export interface AttributeDef {
  /** Definition id (UUID), used to patch or deprecate it. */
  id: string;
  /** Entity type key the attribute belongs to. Immutable. */
  entityType: string;
  /** `u_` + ten lowercase alphanumerics; server-generated and permanent. */
  key: string;
  /** Name shown for the attribute in forms and on the graph. */
  label: string;
  /** Value type of the attribute. Immutable. */
  kind: AttributeKind;
  /** Kind-specific options, or `null` for kinds that take none. */
  options: AttributeDefOptions | null;
  /** Whether extraction may ask the model for this value. */
  extractable: boolean;
  /** Prompt copy telling the model what to look for. Required when `extractable` is true; `null` otherwise. */
  extractionHint: string | null;
  /** How private values are; `null` inherits the entity type's default. */
  sensitivity: Sensitivity | null;
  /** Position among the entity type's attributes; lower comes first. */
  sortOrder: number;
  /** ISO 8601 instant the definition was deprecated, or `null` while it is live. */
  deprecatedAt: string | null;
  /** ISO 8601 instant the definition was created. */
  createdAt: string;
  /** ISO 8601 instant the definition was last changed. */
  updatedAt: string;
}

/**
 * Body for {@link createAttributeDef}.
 *
 * @stability experimental
 */
export interface CreateAttributeDefInput {
  /** Entity type key to add the attribute to. */
  entityType: string;
  /** Display name, at most {@link ATTRIBUTE_LABEL_MAX_LENGTH} characters. */
  label: string;
  /** Value type. Cannot be changed afterwards. */
  kind: AttributeKind;
  /** Choices for `select` and `multi_select`, target types for `entity_ref`; omit for other kinds. */
  options?: AttributeDefOptions;
  /** Whether extraction may ask the model for this value. Defaults to `false`. */
  extractable?: boolean;
  /** Prompt copy for the model; required when `extractable` is true, at most {@link EXTRACTION_HINT_MAX_LENGTH} characters. */
  extractionHint?: string | null;
  /** Privacy of the values; `null` or omitted inherits the entity type's default. */
  sensitivity?: Sensitivity | null;
  /** Position among the entity type's attributes. */
  sortOrder?: number;
}

/**
 * `kind`, `entityType` and `key` are deliberately absent: they are immutable.
 *
 * @stability experimental
 */
export interface PatchAttributeDefInput {
  /** New display name. */
  label?: string;
  /** New options. Choices may be added or relabelled, never removed. */
  options?: AttributeDefOptions;
  /** Whether extraction may ask the model for this value. */
  extractable?: boolean;
  /** New extraction hint, or `null` to clear it. */
  extractionHint?: string | null;
  /** New privacy level, or `null` to inherit the entity type's default. */
  sensitivity?: Sensitivity | null;
  /** New position among the entity type's attributes. */
  sortOrder?: number;
  /** `true` deprecates the definition (hidden from forms and extraction, values kept); `false` restores it. */
  deprecated?: boolean;
}

/**
 * Longest allowed `extractionHint`, in characters.
 *
 * @stability experimental
 */
export const EXTRACTION_HINT_MAX_LENGTH = 500;
/**
 * Longest allowed attribute `label`, in characters.
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
 * Human labels for each sensitivity level, as the UI shows them.
 *
 * @stability experimental
 */
export const SENSITIVITY_LABELS: Record<Sensitivity, string> = {
  business: 'Business',
  personal: 'Personal',
  sensitive: 'Sensitive',
};

/**
 * Lists the caller's own attribute definitions, deprecated ones included (`GET /api/graph/attribute-defs`), optionally for one entity type.
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
 * Creates an attribute definition (`POST /api/graph/attribute-defs`).
 *
 * @stability experimental
 */
export async function createAttributeDef(host: KvoxWebHost, input: CreateAttributeDefInput): Promise<AttributeDef> {
  return kvoxPost<AttributeDef>(host, '/graph/attribute-defs', input);
}

/**
 * Changes a definition (`PATCH /api/graph/attribute-defs/:id`); `kind`, `entityType` and `key` are immutable.
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
 * Deprecates a definition (`DELETE /api/graph/attribute-defs/:id`): the row and every stored value are kept (§17.3).
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
 * Lifecycle state of a proposal: `extracting`, `draft`, `committed`, `discarded`, `failed` or `reverted`. Alias of the contract's `ProposalStatus`.
 *
 * @stability experimental
 */
export type ProposalStatus = ContractProposalStatus;
/**
 * What a proposal was produced from: an AI extraction of a note, an RDF import, or an entity resolution.
 *
 * @stability experimental
 */
export type ProposalKind = 'extraction' | 'import' | 'resolution';
/**
 * A reviewer's decision on a proposal row: `pending`, `accept`, `edit`, `reject` or `merge_into`. Alias of the contract's `ProposalDecision`.
 *
 * @stability experimental
 */
export type ProposalDecision = ContractProposalDecision;
/**
 * The review group a proposal row belongs to: one per shipped entity type, `Other` for any further type, then `relations` and `closings`.
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
  | 'Risk'
  | 'Claim'
  | 'PersonFact'
  | 'Other'
  | 'relations'
  | 'closings';

/**
 * The order the review sheet renders its groups in (#366's `groupKeySchema`).
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
  'Risk',
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
 * A reason a proposal row needs attention, such as `known` or `possible_duplicate`; the values of {@link PROPOSAL_ITEM_FLAGS}. Alias of the contract's `ProposalItemFlag`.
 *
 * @stability experimental
 */
export type ProposalItemFlag = ContractProposalItemFlag;

/**
 * How precisely a date bound is known; same values as {@link DatePrecision}.
 *
 * @stability experimental
 */
export type ValidPrecisionValue = 'day' | 'month' | 'year' | 'unknown';

/** `{ entityId }` — an existing committed entity; `{ ref }` — an entity row of this proposal. */
/**
 * One end of a relation in a proposal: `{ entityId }` for an existing entity or `{ ref }` for an entity row of the same proposal. Alias of the contract's `EndpointRef`.
 *
 * @stability experimental
 */
export type EndpointRef = ContractEndpointRef;

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * Row counts of a proposal, by decision and by review group.
 *
 * @stability experimental
 */
export interface ProposalCounts {
  /** All rows of the proposal. */
  total: number;
  /** Rows still undecided. */
  pending: number;
  /** Rows decided `accept`, `edit` or `merge_into`. */
  accepted: number;
  /** Rows decided `reject`. */
  rejected: number;
  /** Rows flagged `known`: already in the graph, so committing only adds evidence. */
  known: number;
  /** Rows per review group; a group with no rows may be absent. */
  byGroup: Partial<Record<ProposalGroupKey, number>>;
}

/**
 * Guidance the user gave for an extraction (#363's `userGuidanceSchema`).
 *
 * @stability experimental
 */
export interface ProposalUserGuidance {
  /** Entities of the caller's to focus on; each must be a live entity they own. */
  pinnedEntityIds: string[];
  /** Ontology type keys to propose; omitted means every type in the effective ontology. */
  entityTypes?: string[];
  /** Relation type keys to propose; omitted means every extractable relation. */
  relationTypes?: string[];
  /** Free-text instructions for the model. */
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
 * A proposal without its rows: identity, source note, model, counts, outcome and timestamps.
 *
 * @stability experimental
 */
export interface ProposalSummary {
  /** Proposal id (UUID). */
  id: string;
  /** What the proposal was produced from. */
  kind: ProposalKind;
  /** Lifecycle state: `extracting`, `draft`, `committed`, `discarded`, `failed` or `reverted`. */
  status: ProposalStatus;
  /** Source note, or `null` for a proposal not tied to a note. */
  noteId: string | null;
  /** Title of the source note, or `null` when there is none. */
  noteTitle: string | null;
  /** Version of the note the proposal was extracted from. */
  noteVersion: number | null;
  /** The note's current version; greater than `noteVersion` means the note changed since. */
  noteCurrentVersion: number | null;
  /** Model that produced the proposal, or `null` when none ran. */
  model: string | null;
  /** Id of the AI provider the model was run on, or `null`. */
  providerId: string | null;
  /** The guidance the extraction was run with, or `null` when none was given. */
  userGuidance: ProposalUserGuidance | null;
  /** Row counts by decision and group. */
  counts: ProposalCounts;
  /**
   * Stage statistics, loosely typed and passed through from the pipeline. Known keys include `usage`, `proposed`, and (#435) the optional `truncationRetry` flag: the first answer was cut off and the run re-asked once with halved row caps.
   * (#435) the optional `truncationRetry: boolean` — the first answer was cut
   * off and the run re-asked once with halved row caps.
   */
  stats: Record<string, unknown> & {
    /** `true` when the first answer was cut off and the run re-asked with smaller row caps. */
    truncationRetry?: boolean;
  };
  /** Why the proposal failed; `null` unless its status is `failed`. */
  failure: {
    /** Machine-readable failure class. */
    errorClass: ExtractionFailureClass;
    /** The server's message, shown to the user. */
    message: string;
  } | null;
  /** ISO 8601 instant the proposal was created. */
  createdAt: string;
  /** ISO 8601 instant the proposal was committed, or `null` while it has not been. */
  committedAt: string | null;
  /** ISO 8601 instant the proposal was reverted, or `null` if it never was. */
  revertedAt: string | null;
}

/**
 * One citation attached to a proposal row, with enough of the anchor to open and highlight the source.
 *
 * @stability experimental
 */
export interface ProposalEvidence {
  /** Evidence id (UUID). */
  id: string;
  /** Where the quote comes from. `import` means it is cited to the uploaded RDF file itself, with nothing to play or highlight. */
  source: 'segment' | 'note' | 'import';
  /** Transcript the quote is in; segment evidence only. */
  transcriptId: string | null;
  /** Transcript segment the quote is in; segment evidence only. */
  segmentId: string | null;
  /** Revision of the segment when the quote was anchored. */
  segmentRev: number | null;
  /** Start of the quoted moment, in milliseconds from the start of the recording. */
  startMs: number | null;
  /** End of the quoted moment, in milliseconds from the start of the recording. */
  endMs: number | null;
  /** Note the quote is in; note evidence only. */
  noteId: string | null;
  /** Note version the quote was drawn from. */
  noteVersion: number | null;
  /** Offset of the first quoted character in that text. */
  charStart: number | null;
  /** Offset just past the last quoted character. */
  charEnd: number | null;
  /** The exact quoted text. */
  quote: string;
  /** Import evidence: the stored file the row was imported from. */
  importObjectId?: string | null;
  /** Import evidence: the node's IRI in that file. */
  sourceIri?: string | null;
  /** Segment evidence: the speaker's display name at read time, or `null` when unknown. */
  speakerName: string | null;
  /** `true` when the cited text changed since (the segment revision or note version moved on) or its source is gone. */
  stale: boolean;
  /** Segment evidence (#604): whether the cited transcript has a recording to play; `false` for an imported transcript. Absent from an older server: treat `undefined` as `true`. */
  hasAudio?: boolean;
}

/**
 * An existing entity the resolver considers a possible match for a proposed one.
 *
 * @stability experimental
 */
export interface ProposalResolutionCandidate {
  /** Id of the existing entity. */
  entityId: string;
  /** Its display name. */
  label: string;
  /** Its entity type key. */
  type: string;
  /** Similarity score of the match; higher is closer. */
  score: number;
  /** Names of the resolver signals that contributed to the score. */
  signals: string[];
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * How a proposed entity was matched against the existing graph.
 *
 * @stability experimental
 */
export interface ProposalResolution {
  /** Id of the existing entity it was linked to; `null` means it is treated as new. */
  ref: string | null;
  /** Score of the link, or `null` when it was not matched by score. */
  score: number | null;
  /** What decided the link, or `null` when nothing did. */
  source: string | null;
  /** Other existing entities considered, best first. */
  candidates: ProposalResolutionCandidate[];
  /** The model's verdict when the resolver asked it to adjudicate, or `null` when it did not. */
  adjudication: {
    /** Whether the model judged the candidate the same entity, a different one, or could not tell. */
    verdict: 'same' | 'different' | 'uncertain';
    /** The model's reasoning for the verdict. */
    rationale: string;
    /** Model that gave the verdict. */
    model: string;
  } | null;
  /** Label of `ref` / the `mergeIntoId` target. */
  refLabel: string | null;
}

/**
 * One reviewable row of a proposal: an entity, a relation, a knowledge item or a closing of an earlier relation.
 *
 * @stability experimental
 */
export interface ProposalItem {
  /** Row id (UUID). */
  id: string;
  /** What the row proposes to write. */
  kind: 'entity' | 'relation' | 'item' | 'closing';
  /** Whether the model proposed the row (`ai`) or the user added it by hand (`user`). */
  origin: 'ai' | 'user';
  /** The review group the row is listed under. */
  groupKey: ProposalGroupKey;
  /** The reviewer's decision so far; `pending` until they decide. */
  decision: ProposalDecision;
  /** The row as proposed, in the shape of its kind. */
  payload: Record<string, unknown>;
  /** The reviewer's edited version, or `null` when unedited. */
  editedPayload: Record<string, unknown> | null;
  /** `editedPayload ?? payload`, with relinks applied; what committing would write. */
  effectivePayload: Record<string, unknown>;
  /** Title and subtitle the sheet shows for the row. */
  display: {
    /** Primary line. */
    title: string;
    /** Secondary line, or `null`. */
    subtitle: string | null;
  };
  /** How the row was matched to the existing graph, or `null` for rows that are not entities. */
  resolution: ProposalResolution | null;
  /** Entity the reviewer chose to merge this row into, or `null`. */
  mergeIntoId: string | null;
  /** Ids of candidates the reviewer marked "not the same as". */
  distinctFrom: string[];
  /** Values of {@link PROPOSAL_ITEM_FLAGS}; typed `string` because the wire may carry a newer one. */
  flags: string[];
  /** Whether the extraction pre-ticked this row. */
  prechecked: boolean;
  /** Citations supporting the row. */
  evidence: ProposalEvidence[];
  /** Id of the entity, relation or item this row created once committed, or `null` before that. */
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
 * A proposal with all its rows (`GET /api/graph/proposals/:id`).
 *
 * @stability experimental
 */
export interface ProposalDetail {
  /** The proposal itself. */
  proposal: ProposalSummary;
  /** Its rows, ordered by review group then `display.title`. */
  items: ProposalItem[];
  /** The exact prompt the extraction sent; only present when requested with `include=context`, `null` otherwise. */
  context: {
    /** System prompt sent to the model. */
    systemPrompt: string;
    /** User message sent to the model. */
    userContent: string;
  } | null;
}

/**
 * A citation to attach to a proposal row, anchored in a note version or a transcript segment. Alias of the contract's `EvidenceSpanInput`.
 *
 * @stability experimental
 */
export type EvidenceSpanInput = ContractEvidenceSpanInput;

/**
 * An endpoint of a proposal row that can be re-pointed: `from`, `to`, `subject`, `owner`, `counterparty` or `meeting`. Alias of the contract's `RelinkField`.
 *
 * @stability experimental
 */
export type RelinkField = ContractRelinkField;

/**
 * Body of a decision on one proposal row (`PATCH /api/graph/proposals/:id/items/:itemId`).
 *
 * @stability experimental
 */
export interface PatchProposalItemInput {
  /** The new decision. */
  decision: ProposalDecision;
  /** The full payload of the row's kind; required when `decision` is `edit`. */
  editedPayload?: Record<string, unknown>;
  /** Existing entity the row is the same as; required when `decision` is `merge_into` (entity rows only). */
  mergeIntoId?: string;
  /** Re-points one endpoint of a relation or item row. */
  relinkTo?: {
    /** Which endpoint to re-point. */
    field: RelinkField;
    /** The new endpoint; `null` only for owner, counterparty and meeting. */
    target: EndpointRef | null;
  };
  /** Entity rows: candidates the row is "not the same as". */
  distinctFrom?: string[];
  /** Citations to add to or remove from the row. */
  evidence?: {
    /** Evidence spans to add. */
    add?: EvidenceSpanInput[];
    /** Ids of evidence rows to remove. */
    remove?: string[];
  };
}

/**
 * What a single row decision returns: the updated row and the proposal's new counts.
 *
 * @stability experimental
 */
export interface PatchProposalItemResult {
  /** The row after the decision. */
  item: ProposalItem;
  /** The proposal's counts after the decision. */
  counts: ProposalCounts;
}

/**
 * A decision that can be applied to many rows at once.
 *
 * @stability experimental
 */
export type BulkDecision = 'accept' | 'reject' | 'pending';

/**
 * Why a bulk decision skipped a row: `not_found`, or a sensitive or closing row that needs an individual accept. Alias of the contract's `BulkSkipReason`.
 *
 * @stability experimental
 */
export type BulkSkipReason = ContractBulkSkipReason;

/**
 * Outcome of a bulk decision.
 *
 * @stability experimental
 */
export interface BulkDecideResult {
  /** How many rows were changed. */
  updated: number;
  /** Rows left unchanged, each with the reason. */
  skipped: Array<{
    /** Id of the skipped row. */
    itemId: string;
    /** Why it was skipped (not found, or a sensitive or closing row that must be accepted individually). */
    reason: BulkSkipReason;
  }>;
  /** The proposal's counts after the decision. */
  counts: ProposalCounts;
}

/**
 * Body for adding a row by hand to a draft proposal (#366's `addItemSchema`, used by "Add to graph").
 *
 * @stability experimental
 */
export interface AddProposalItemInput {
  /** Which kind of row to add. */
  kind: 'entity' | 'relation' | 'item';
  /** The row's payload; the server assigns `ref` and computes an item's `statementHash`. */
  payload: Record<string, unknown>;
  /** Entity rows only: the row is this existing entity, which records the decision `merge_into`. */
  existingEntityId?: string;
  /** One to ten citations for the row. */
  evidence: EvidenceSpanInput[];
}

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * What a commit wrote to the graph.
 *
 * @stability experimental
 */
export interface CommitResult {
  /** Rows newly created. */
  created: {
    /** Entities created. */
    entities: number;
    /** Relations created. */
    relations: number;
    /** Knowledge items created. */
    items: number;
  };
  /** Rows linked to an existing entity instead of created. */
  linked: number;
  /** Evidence rows written, including appends to rows that already existed. */
  evidenceAdded: number;
  /** Closings of earlier relations that took effect. */
  closingsApplied: number;
  /** Closings that could not be applied. */
  closingsSkipped: number;
  /** Existing items replaced by a newer one. */
  superseded: number;
  /** Aliases added to existing entities. */
  aliasesAdded: number;
  /** "Not the same as" pairs recorded. */
  distinctPairsRecorded: number;
  /** Rows still `pending`: neither committed nor remembered as rejected. */
  skippedPending: number;
  /** Props that `known` relation rows added to the live relations they matched (#444); only keys the relation did not hold, never an overwrite. */
  propsFilled?: number;
}

/**
 * Why a row was kept when a proposal was reverted: it was edited, referenced, merged or given new evidence after the commit.
 *
 * @stability experimental
 */
export type RevertKeptWhy = 'edited_since' | 'referenced_since' | 'merged_since' | 'evidence_since';

/**
 * A row a revert kept, with the reason it was kept. Alias of the contract's `RevertKept`.
 *
 * @stability experimental
 */
export type RevertKept = ContractRevertKept;

/**
 * Outcome of a revert: how many rows were reverted and which were kept. Alias of the contract's `RevertResult`.
 *
 * @stability experimental
 */
export type RevertResult = ContractRevertResult;

/**
 * Filters and paging for {@link listProposals}.
 *
 * @stability experimental
 */
export interface ListProposalsParams {
  /** Only proposals in this state (the API defaults to `draft`). */
  status?: ProposalStatus;
  /** Only proposals of this kind. */
  kind?: ProposalKind;
  /** Only proposals extracted from this note. */
  noteId?: string;
  /** Only proposals whose note derives, directly or through a chain of notes, from this transcript. */
  transcriptId?: string;
  /** The `nextCursor` of the previous page. */
  cursor?: string;
  /** Page size (the API allows 1 to 50, default 20). */
  limit?: number;
}

/**
 * Body for {@link requestExtraction} (#363's `requestExtractionSchema`).
 *
 * @stability experimental
 */
export interface RequestExtractionInput {
  /** Model to run the extraction with; omitted means the deployment's `graph.extract` task model. */
  model?: string;
  /** Guidance to steer the extraction. */
  userGuidance?: Partial<ProposalUserGuidance>;
}

/** #363's `extractionEstimateSchema`. */
/**
 * What an extraction of a note would cost without running it: model, token counts, whether the prompt fits and whether the caller has a key. Alias of the contract's `ExtractionEstimate`.
 *
 * @stability experimental
 */
export type ExtractionEstimate = ContractExtractionEstimate;

/**
 * The accepted extraction request (#363's `requestExtractionResponseSchema`, HTTP 202).
 *
 * @stability experimental
 */
export interface RequestExtractionResult {
  /** The new proposal, still `extracting`. */
  proposal: {
    /** Proposal id (UUID). */
    id: string;
    /** Note being extracted. */
    noteId: string;
    /** Version of the note being extracted. */
    noteVersion: number;
    /** Always `extracting` at this point. */
    status: 'extracting';
    /** Model the job will use. */
    model: string;
    /** Provider of that model. */
    providerId: string;
    /** ISO 8601 instant the proposal was created. */
    createdAt: string;
  };
  /** Token and cost estimate for the run. */
  estimate: ExtractionEstimate;
}

/**
 * One row of the entity search used by pickers (#370).
 *
 * @stability experimental
 */
export interface GraphEntitySearchResult {
  /** Entity id (UUID). */
  id: string;
  /** Entity type key. */
  type: string;
  /** Display name. */
  label: string;
  /** Other names that matched. */
  aliases: string[];
}

const proposalPath = (id: string) => `/graph/proposals/${encodeURIComponent(id)}`;

/**
 * Fetches the newest non-discarded proposal of a note (`GET /api/graph/notes/:noteId/proposal`), or `null` when there is none.
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
 * Fetches one proposal (`GET /api/graph/proposals/:id`), optionally with the prompt that produced it.
 *
 * @stability experimental
 */
export async function getProposal(
  host: KvoxWebHost,
  id: string,
  options: {
    /** Also return the exact prompt the extraction sent (`include=context`); off by default. */
    includeContext?: boolean;
  } = {},
): Promise<ProposalDetail> {
  const query = options.includeContext ? '?include=context' : '';
  return kvoxGet<ProposalDetail>(host, `${proposalPath(id)}${query}`);
}

/**
 * Lists proposals, newest first (`GET /api/graph/proposals`), filtered by status, kind, note or transcript.
 *
 * @stability experimental
 */
export async function listProposals(
  host: KvoxWebHost,
  params: ListProposalsParams = {},
): Promise<{
  /** The proposals on this page. */
  items: ProposalSummary[];
  /** Cursor for the next page, or `null` on the last one. */
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
 * Records a decision on one proposal row (`PATCH /api/graph/proposals/:id/items/:itemId`): accept, edit, reject, merge, relink and evidence changes.
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
 * Applies one decision to many rows of a proposal at once (`POST /api/graph/proposals/:id/items/bulk`); rows that need an individual decision are skipped and reported.
 *
 * @stability experimental
 */
export async function bulkDecideProposalItems(
  host: KvoxWebHost,
  proposalId: string,
  body: {
    /** Ids of the rows to decide, 1 to 500. */
    itemIds: string[];
    /** The decision to apply to every row. */
    decision: BulkDecision;
  },
): Promise<BulkDecideResult> {
  return kvoxPost<BulkDecideResult>(host, `${proposalPath(proposalId)}/items/bulk`, body);
}

/**
 * Adds a row by hand to a draft proposal (`POST /api/graph/proposals/:id/items`), for "Add to graph".
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
 * Commits a draft proposal into the graph (`POST /api/graph/proposals/:id/commit`).
 *
 * @stability experimental
 */
export async function commitProposal(
  host: KvoxWebHost,
  id: string,
): Promise<{
  /** The proposal, now committed. */
  proposal: ProposalSummary;
  /** What the commit wrote. */
  result: CommitResult;
}> {
  return kvoxPost(host, `${proposalPath(id)}/commit`, {});
}

/**
 * Discards a draft proposal (`POST /api/graph/proposals/:id/discard`) without writing anything.
 *
 * @stability experimental
 */
export async function discardProposal(host: KvoxWebHost, id: string): Promise<{
  /** The proposal, now discarded. */
  proposal: ProposalSummary;
}> {
  return kvoxPost(host, `${proposalPath(id)}/discard`, {});
}

/**
 * Reverts a committed proposal (`POST /api/graph/proposals/:id/revert`). Rows changed since the commit are kept and listed.
 *
 * @stability experimental
 */
export async function revertProposal(
  host: KvoxWebHost,
  id: string,
  options: {
    /** Revert what can be reverted even when some rows changed since the commit; they are kept and listed in the result. */
    confirmPartial: boolean;
  },
): Promise<{
  /** The proposal, now reverted. */
  proposal: ProposalSummary;
  /** How many rows were reverted and which were kept. */
  result: RevertResult;
}> {
  return kvoxPost(host, `${proposalPath(id)}/revert`, { confirmPartial: options.confirmPartial });
}

/**
 * Starts an extraction for a note (`POST /api/graph/notes/:noteId/extract`); answers 202 with the proposal in `extracting` state.
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
 * Searches entities by label for the re-link and merge pickers (`GET /api/graph/entities?type&q&limit`) and returns the matching rows.
 *
 * @stability experimental
 */
export async function searchGraphEntities(
  host: KvoxWebHost,
  params: {
    /** Restrict the search to one entity type key. */
    type?: string;
    /** Text to match against labels and aliases. */
    q: string;
    /** Most rows to return; defaults to 10. */
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
 * Value of `details.reason` on a graph 409, such as `graph_empty` or `offer_decided`. Alias of the contract's `GraphConflictReason`.
 *
 * @stability experimental
 */
export type GraphConflictReason = ContractGraphConflictReason;

/**
 * Reads `details.reason` of a graph 409, or `null` when the error is not a recognised conflict.
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
 * Reads `details.conflicts` of a 409 `revert_conflict`, or `null` for any other error.
 *
 * @stability experimental
 */
export function revertConflictDetails(
  err: unknown,
): {
  /** The rows a revert would keep because they changed since the commit. */
  conflicts: RevertKept[];
  /** How many rows a revert could still undo. */
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
 * Reads `details.issues` of a 400 (Zod issues, each with a `path`), or `null` for any other error.
 *
 * @stability experimental
 */
export function graphValidationIssues(
  err: unknown,
): Array<{
  /** Path to the offending field in the request body. */
  path: Array<string | number>;
  /** What is wrong with it. */
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
 * The guidance for an extraction as the extract dialog holds it: pinned entities, type filters and instructions. Alias of the contract's `UserGuidance`.
 *
 * @stability experimental
 */
export type UserGuidance = ContractUserGuidance;

/**
 * Most entities one extraction may pin (#363's `userGuidanceSchema` limit).
 *
 * @stability experimental
 */
export const GUIDANCE_MAX_PINNED = 50;
/**
 * Longest `instructions` text one extraction accepts, in characters.
 *
 * @stability experimental
 */
export const GUIDANCE_MAX_INSTRUCTIONS = 2000;

/**
 * Fetches what an extraction of a note would cost (`GET /api/graph/extract/estimate`); needs no AI key.
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
  /** Guidance entity type keys the API does not know. */
  unknownTypes: string[];
  /** Pinned ids that are not live entities the caller owns. */
  invalidPinnedIds: string[];
  /** `true` when the chosen model is not one the deployment permits. */
  modelNotPermitted: boolean;
  /** Set when the note does not fit the model's input budget; `null` otherwise. */
  budget: {
    /** Tokens the prompt needs. */
    promptTokens: number;
    /** Input tokens the model can take. */
    availableInputTokens: number;
    /** The model the budget was measured against, when the API named one. */
    model: string | null;
  } | null;
}

/**
 * Reads the `details` of a 400 from the extract call or its estimate into an {@link ExtractBadRequest}, or `null` when the error is not a 400.
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
 * The most nodes an overview carries (the top by degree).
 *
 * @stability experimental
 */
export const OVERVIEW_MAX_NODES = 5000;

/**
 * One of the highest-degree entities sampled from a cluster.
 *
 * @stability experimental
 */
export interface GraphOverviewMember {
  /** Entity id (UUID). */
  id: string;
  /** Display name. */
  label: string;
  /** Entity type key. */
  type: string;
  /** Readable edges the entity has in the whole graph. */
  degree: number;
}

/**
 * One cluster of the whole-graph layout snapshot.
 *
 * @stability experimental
 */
export interface GraphOverviewCluster {
  /** Cluster id, stable within one snapshot only. `-1` is "Unconnected": every isolated entity, pooled. */
  id: number;
  /** Live label of `labelEntityId`; else `Cluster <id + 1>`; `Unconnected` for `-1`. */
  label: string;
  /** The entity the cluster is named after, when it is still readable. */
  labelEntityId: string | null;
  /** Members at the time of the snapshot. */
  size: number;
  /** Horizontal centre of the cluster in layout space. */
  x: number;
  /** Vertical centre of the cluster in layout space. */
  y: number;
  /** Radius of the cluster in layout space. */
  radius: number;
  /** Number of members per entity type key. */
  typeCounts: Record<string, number>;
  /** Up to 8 members by degree. */
  memberSample: GraphOverviewMember[];
}

/**
 * A weighted link between two clusters.
 *
 * @stability experimental
 */
export interface GraphOverviewClusterEdge {
  /** Id of one cluster. */
  a: number;
  /** Id of the other cluster. */
  b: number;
  /** How strongly the two clusters are connected; larger means more relations between them. */
  weight: number;
}

/**
 * One positioned entity of the overview, in the nodes layer.
 *
 * @stability experimental
 */
export interface GraphOverviewNode {
  /** Entity id (UUID). */
  id: string;
  /** Display name. */
  label: string;
  /** Entity type key. */
  type: string;
  /** Horizontal position in layout space. */
  x: number;
  /** Vertical position in layout space. */
  y: number;
  /** Id of the cluster the entity belongs to. */
  clusterId: number;
  /** Readable edges the entity has in the whole graph. */
  degree: number;
}

/**
 * The latest whole-graph layout snapshot (`GET /api/graph/overview`), with labels read live.
 *
 * @stability experimental
 */
export interface GraphOverview {
  /** `ready` when a snapshot exists, `none` when none has been computed yet. */
  status: 'ready' | 'none';
  /** A `kg.graph_layout` job is pending or running for the caller. */
  pending: boolean;
  /** ISO 8601 instant the snapshot was computed, or `null` when there is none. */
  computedAt: string | null;
  /** The graph changed after the snapshot read it. Reported, never auto-refreshed. */
  stale: boolean;
  /** The graph exceeded the layout ceiling; no clusters or positions are returned. */
  tooLarge: boolean;
  /** Entities in the snapshot. */
  nodeCount: number;
  /** Relations in the snapshot. */
  edgeCount: number;
  /** Clusters, with their centre, radius and a member sample. */
  clusters: GraphOverviewCluster[];
  /** Weighted links between clusters (the API caps them at 500). */
  clusterEdges: GraphOverviewClusterEdge[];
  /** Positioned entities, the top {@link OVERVIEW_MAX_NODES} by degree. */
  nodes: GraphOverviewNode[];
  /** `true` when more positioned nodes exist than `nodes` carries. */
  nodesTruncated: boolean;
}

/**
 * Answer to a layout refresh: the `kg.graph_layout` job id and whether one was already queued. Alias of the contract's `GraphOverviewRefreshResponse`.
 *
 * @stability experimental
 */
export type GraphOverviewRefreshResponse = ContractGraphOverviewRefreshResponse;

/**
 * Fetches the stored layout snapshot (`GET /api/graph/overview`, `graph:read`). Never recomputes.
 *
 * @stability experimental
 */
export function getGraphOverview(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphOverview> {
  return kvoxGet<GraphOverview>(host, '/graph/overview', { signal });
}

/**
 * Queues a fresh layout (`POST /api/graph/overview/refresh`, `graph:write`); answers 202 and reuses a layout job already pending.
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
 * File format of a graph export: `jsonld`, `turtle` or `nquads`. Alias of the contract's `GraphExportFormat`.
 *
 * @stability experimental
 */
export type GraphExportFormat = ContractGraphExportFormat;
/**
 * Lifecycle of a graph export: `pending` or `running` while the `kg.export` job works, then `ready` or `failed`.
 *
 * @stability experimental
 */
export type GraphExportStatus = 'pending' | 'running' | 'ready' | 'failed';

/**
 * Counts of what an export contains; empty until it is `ready`.
 *
 * @stability experimental
 */
export interface GraphExportStats {
  /** Entities exported. */
  entities?: number;
  /** Relations exported. */
  relations?: number;
  /** Knowledge items exported. */
  items?: number;
  /** Evidence links exported. */
  evidence?: number;
  /** Sensitive person facts and attribute values left out; they never leave the deployment. */
  excludedSensitive?: number;
  /** Size of the file in bytes. */
  bytes?: number;
}

/**
 * One graph export and the file it produced.
 *
 * @stability experimental
 */
export interface GraphExport {
  /** Export id (UUID). */
  id: string;
  /** File format: JSON-LD, Turtle or N-Quads. */
  format: GraphExportFormat;
  /** Where the export is in its lifecycle. */
  status: GraphExportStatus;
  /** The ontology version the export was requested against. */
  ontologyVersion: string;
  /** What the file contains; empty until ready. */
  stats: GraphExportStats;
  /** Why the export failed, or `null`. Never row data. */
  errorMessage: string | null;
  /** ISO 8601 instant the export was requested. */
  createdAt: string;
  /** When the export and its file are deleted (7 days after the request). */
  expiresAt: string;
  /** A short-lived signed URL serving the file as an attachment. `null` unless the export is `ready`. */
  downloadUrl: string | null;
  /** Name of the downloaded file. */
  filename: string;
}

/**
 * Answer to an export request: the export, and whether an unchanged one was reused. Alias of the contract's `CreateGraphExportResponse`.
 *
 * @stability experimental
 */
export type CreateGraphExportResponse = ContractCreateGraphExportResponse;

/**
 * Requests an export (`POST /api/graph/exports`, `graph:read`): 202 when queued, 200 when an unchanged export already existed, 409 `graph_empty` for an empty graph.
 *
 * @stability experimental
 */
export function exportGraph(host: KvoxWebHost, format: GraphExportFormat): Promise<CreateGraphExportResponse> {
  return kvoxPost<CreateGraphExportResponse>(host, '/graph/exports', { format });
}

/**
 * Fetches one export (`GET /api/graph/exports/:id`, `graph:read`); 404 for a foreign or expired one.
 *
 * @stability experimental
 */
export function getGraphExport(host: KvoxWebHost, id: string, signal?: AbortSignal): Promise<GraphExport> {
  return kvoxGet<GraphExport>(host, `/graph/exports/${encodeURIComponent(id)}`, { signal });
}

/**
 * Lists the caller's unexpired exports, newest first (`GET /api/graph/exports`, `graph:read`).
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
 * File format of a graph import: `turtle`, `jsonld` or `nquads`. Alias of the contract's `GraphImportFormat`.
 *
 * @stability experimental
 */
export type GraphImportFormat = ContractGraphImportFormat;

/**
 * Why an import failed: `parse_error`, `too_large`, `ontology_version_newer`, `migration_pending`, `shacl_violations` or `empty`. Alias of the contract's `GraphImportFailureReason`.
 *
 * @stability experimental
 */
export type GraphImportFailureReason = ContractGraphImportFailureReason;

/**
 * Extensions the import file picker accepts; the ones `POST /api/graph/imports` reads.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_ACCEPT = '.ttl,.jsonld,.json,.nq';

/**
 * The largest file an import accepts (20 MiB), checked in the browser before the upload too.
 *
 * @stability experimental
 */
export const GRAPH_IMPORT_MAX_BYTES = 20 * 1024 * 1024;

/**
 * One validation failure found in an imported file: the node and property it is about. Alias of the contract's `GraphImportViolation`.
 *
 * @stability experimental
 */
export type GraphImportViolation = ContractGraphImportViolation;

// TODO(web-domain): align with @marinoscar/kvox-contract
/**
 * A property in an imported file the ontology does not know, which the user may adopt as an attribute.
 *
 * @stability experimental
 */
export interface GraphImportOffer {
  /** Identifies the offer within its proposal; names it in the accept and reject routes. */
  offerId: string;
  /** The property IRI the file used. */
  iri: string;
  /** The file's own `rdfs:label` for the property, or `null` when it states none. */
  label: string | null;
  /** How many values of the property the file carried. */
  count: number;
  /** Entity or item type keys carrying the property. `Assertion` means it sat on a relation, which can never become an attribute. */
  subjectTypes: string[];
  /** Up to three example values, each at most 80 characters. */
  sampleValues: string[];
  /** Attribute kind suggested from the values' datatypes. */
  suggestedKind: string;
  /** Whether the offer is still open, was adopted as an attribute, or was turned down. */
  status: 'offered' | 'accepted' | 'rejected';
}

/**
 * `proposal.stats` of a `kind: import` proposal. Only `filename`, `format` and `bytes` exist while the import is extracting.
 *
 * @stability experimental
 */
// TODO(web-domain): align with @marinoscar/kvox-contract
export interface GraphImportStats {
  /** Name of the uploaded file. */
  filename?: string;
  /** Detected file format. */
  format?: GraphImportFormat;
  /** Size of the file in bytes. */
  bytes?: number;
  /** Number of RDF triples read. */
  triples?: number;
  /** The file's `owl:versionInfo`, or its most common `kv:ontologyVersion`. */
  sourceOntologyVersion?: string | null;
  /** Set when the file was older and declared migrations reshaped it in memory. */
  migratedFrom?: string | null;
  /** Result of validating the file against the ontology. */
  validation?: {
    /** `true` when the file has no violations. */
    conforms: boolean;
    /** The violations found, capped by the API; `violationCount` has the total. */
    violations: GraphImportViolation[];
    /** Total number of violations, which may exceed `violations`. */
    violationCount: number;
  };
  /** Properties the ontology does not know, offered for adoption as attributes. */
  unknownProperties?: GraphImportOffer[];
  /** What the import produced. */
  counts?: {
    /** Entities read from the file. */
    entities: number;
    /** Relations read from the file. */
    relations: number;
    /** Knowledge items read from the file. */
    items: number;
    /** Sensitive person facts and attribute values the file carried; never imported in bulk. */
    skippedSensitive: number;
  };
  /** Why the import failed, when it did. */
  failureReason?: GraphImportFailureReason | null;
}

/**
 * Reads the import facts of a proposal summary into {@link GraphImportStats}. Never throws; absent fields stay absent.
 *
 * @stability experimental
 */
export function importStatsOf(summary: ProposalSummary | null | undefined): GraphImportStats {
  return (summary?.stats ?? {}) as GraphImportStats;
}

/**
 * Answer to an upload: the `kind: import` proposal id and the `kg.import` job id. Alias of the contract's `CreateGraphImportResponse`.
 *
 * @stability experimental
 */
export type CreateGraphImportResponse = ContractCreateGraphImportResponse;

/**
 * Uploads a graph file (`POST /api/graph/imports`, `graph:write`, multipart); answers 202 and failures surface as `KvoxApiError` (400, 409, 413).
 *
 * @stability experimental
 */
export function uploadGraphImport(host: KvoxWebHost, file: File): Promise<CreateGraphImportResponse> {
  const form = new FormData();
  form.append('file', file);
  return kvoxPostFormData<CreateGraphImportResponse>(host, '/graph/imports', form);
}

/**
 * What accepting or rejecting an attribute offer changed.
 *
 * @stability experimental
 */
export interface AttributeOfferResult {
  /** The offer, with its new status. */
  offer: GraphImportOffer;
  /** The attribute definitions created, one per entity type carrying the property; empty on reject. */
  attributeDefs: AttributeDef[];
  /** Proposal rows whose `props` now carry the values. */
  rowsUpdated: number;
  /** Values that could not be kept, for example a reference to a row not linked to an existing entity. */
  valuesDropped: number;
}

const offerPath = (proposalId: string, offerId: string, action: 'accept' | 'reject') =>
  `${proposalPath(proposalId)}/attribute-offers/${encodeURIComponent(offerId)}/${action}`;

/**
 * Adopts an unknown imported property as an attribute (`POST /api/graph/proposals/:id/attribute-offers/:offerId/accept`, `graph:write`), optionally with a label.
 *
 * @stability experimental
 */
export function acceptAttributeOffer(host: KvoxWebHost, proposalId: string, offerId: string, label?: string): Promise<AttributeOfferResult> {
  return kvoxPost<AttributeOfferResult>(host, offerPath(proposalId, offerId, 'accept'), label ? { label } : {});
}

/**
 * Turns down an unknown imported property (`POST /api/graph/proposals/:id/attribute-offers/:offerId/reject`, `graph:write`).
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
    /** The model the task would run on, or `null` when none is resolved. */
    model: string | null;
  }>;
}

/**
 * `GET /api/ai-tasks/config` — requires `notes:read`, which every seeded role holds.
 *
 * @param host - The host whose HTTP port performs the request.
 * @param signal - Aborts the request.
 * @returns The viewer's AI availability.
 *
 * @stability experimental
 */
export function getGraphAiConfig(host: KvoxWebHost, signal?: AbortSignal): Promise<GraphAiConfig> {
  return kvoxGet<GraphAiConfig>(host, '/ai-tasks/config', { signal });
}

// -----------------------------------------------------------------------------
// Topics from past meetings (#666, epic #661)
// -----------------------------------------------------------------------------

/**
 * Answer to a request to find topics in past meetings. Alias of the contract's `TopicsPromoteRequestResponse`.
 *
 * @stability experimental
 */
export type TopicsPromoteRequestResponse = ContractTopicsPromoteRequestResponse;

/**
 * Where the latest "Find topics in past meetings" run stands. Alias of the contract's `TopicsPromoteStatus`.
 *
 * @stability experimental
 */
export type TopicsPromoteStatus = ContractTopicsPromoteStatus;

/**
 * Queues the `kg.topics_promote` job for the caller (`POST /api/graph/topics/promote`, `graph:write`, 202).
 * It uses the caller's own AI key, so it only ever runs on a click. 409 `graph_disabled` when connected knowledge is off.
 *
 * @param host - The host whose HTTP port performs the request.
 * @returns The queued run, or the one already in flight.
 *
 * @stability experimental
 */
export function requestTopicsPromote(host: KvoxWebHost): Promise<TopicsPromoteRequestResponse> {
  return kvoxPost<TopicsPromoteRequestResponse>(host, '/graph/topics/promote', {});
}

/**
 * Reads the latest run and the topic proposals waiting for review (`GET /api/graph/topics/promote`, `graph:write`).
 *
 * @param host - The host whose HTTP port performs the request.
 * @param signal - Aborts the request.
 * @returns The latest run (or `null`) and the count of proposals waiting.
 *
 * @stability experimental
 */
export function getTopicsPromoteStatus(host: KvoxWebHost, signal?: AbortSignal): Promise<TopicsPromoteStatus> {
  return kvoxGet<TopicsPromoteStatus>(host, '/graph/topics/promote', { signal });
}
