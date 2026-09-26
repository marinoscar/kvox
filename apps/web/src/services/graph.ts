/**
 * Connected knowledge (the graph) — the web client's transport (#369, epic #346).
 *
 * Two surfaces today:
 *
 *   `GET /api/graph/ontology` (#354)          the caller's effective ontology —
 *                                             domains, entity types and every
 *                                             attribute, built-in and their own.
 *   `/api/graph/attribute-defs[/:id]` (#355)  the caller's own attribute
 *                                             definitions. `kind`, `entityType`
 *                                             and `key` are immutable; a
 *                                             "delete" deprecates (§17.3).
 *
 * Every difference between the API's wire shape and what the settings page
 * wants is absorbed HERE, so components never learn the transport.
 */

import type {
  AttributeKind,
  EffectiveSchemaPayload,
  Sensitivity,
} from '@app/shared/ontology';

import { api, ApiError } from './api';

export type GraphOntology = EffectiveSchemaPayload;
export type GraphEntityType = EffectiveSchemaPayload['entityTypes'][number];
export type GraphAttribute = GraphEntityType['attributes'][number];
export type GraphDomain = EffectiveSchemaPayload['domains'][number];

export type { AttributeKind, Sensitivity };

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

/** `GET /api/graph/ontology` — the caller's effective ontology. */
export async function getGraphOntology(): Promise<GraphOntology> {
  return api.get<GraphOntology>('/graph/ontology');
}

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

// =============================================================================
// Proposals — the review sheet's transport (#367, epic #346)
// =============================================================================
//
// Mirrors the Contract of #366 (`apps/api/src/graph/proposals/dto/proposal.dto.ts`)
// field for field, plus #363's `POST /api/graph/notes/:noteId/extract` and
// `proposal-payload.schema.ts`, and #370's entity search. Components import
// these types and functions; none of them learns a URL.

export type ProposalStatus = 'extracting' | 'draft' | 'committed' | 'discarded' | 'failed' | 'reverted';
export type ProposalKind = 'extraction' | 'import' | 'resolution';
export type ProposalDecision = 'pending' | 'accept' | 'edit' | 'reject' | 'merge_into';
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

/** #366's `groupKeySchema` order — the order the sheet renders groups in. */
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
export type ProposalItemFlag = (typeof PROPOSAL_ITEM_FLAGS)[number];

export type ValidPrecisionValue = 'day' | 'month' | 'year' | 'unknown';

/** `{ entityId }` — an existing committed entity; `{ ref }` — an entity row of this proposal. */
export type EndpointRef = { entityId: string } | { ref: string };

export interface ProposalCounts {
  total: number;
  pending: number;
  accepted: number;
  rejected: number;
  known: number;
  byGroup: Partial<Record<ProposalGroupKey, number>>;
}

/** #363's `userGuidanceSchema`. */
export interface ProposalUserGuidance {
  pinnedEntityIds: string[];
  entityTypes?: string[];
  relationTypes?: string[];
  instructions: string;
}

export interface ProposalSummary {
  id: string;
  kind: ProposalKind;
  status: ProposalStatus;
  noteId: string | null;
  noteTitle: string | null;
  noteVersion: number | null;
  noteCurrentVersion: number | null;
  model: string | null;
  providerId: string | null;
  userGuidance: ProposalUserGuidance | null;
  counts: ProposalCounts;
  stats: Record<string, unknown>;
  failure: { errorClass: string; message: string } | null;
  createdAt: string;
  committedAt: string | null;
  revertedAt: string | null;
}

export interface ProposalEvidence {
  id: string;
  source: 'segment' | 'note';
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
  speakerName: string | null;
  stale: boolean;
}

export interface ProposalResolutionCandidate {
  entityId: string;
  label: string;
  type: string;
  score: number;
  signals: string[];
}

export interface ProposalResolution {
  /** The linked existing entity id; null = new. */
  ref: string | null;
  score: number | null;
  source: string | null;
  candidates: ProposalResolutionCandidate[];
  adjudication: { verdict: 'same' | 'different' | 'uncertain'; rationale: string; model: string } | null;
  /** Label of `ref` / the `mergeIntoId` target. */
  refLabel: string | null;
}

export interface ProposalItem {
  id: string;
  kind: 'entity' | 'relation' | 'item' | 'closing';
  origin: 'ai' | 'user';
  groupKey: ProposalGroupKey;
  decision: ProposalDecision;
  payload: Record<string, unknown>;
  editedPayload: Record<string, unknown> | null;
  effectivePayload: Record<string, unknown>;
  display: { title: string; subtitle: string | null };
  resolution: ProposalResolution | null;
  mergeIntoId: string | null;
  distinctFrom: string[];
  /** Values of {@link PROPOSAL_ITEM_FLAGS}; typed `string` because the wire may carry a newer one. */
  flags: string[];
  prechecked: boolean;
  evidence: ProposalEvidence[];
  committedRefId: string | null;
}

export interface ProposalDetail {
  proposal: ProposalSummary;
  items: ProposalItem[];
  context: { systemPrompt: string; userContent: string } | null;
}

export type EvidenceSpanInput =
  | { source: 'note'; noteVersion: number; charStart: number; charEnd: number; quote: string }
  | {
      source: 'segment';
      segmentId: string;
      segmentRev: number;
      charStart: number;
      charEnd: number;
      quote: string;
    };

export type RelinkField = 'from' | 'to' | 'subject' | 'owner' | 'counterparty' | 'meeting';

/** #366's `patchItemSchema`. */
export interface PatchProposalItemInput {
  decision: ProposalDecision;
  editedPayload?: Record<string, unknown>;
  mergeIntoId?: string;
  relinkTo?: { field: RelinkField; target: EndpointRef | null };
  distinctFrom?: string[];
  evidence?: { add?: EvidenceSpanInput[]; remove?: string[] };
}

export interface PatchProposalItemResult {
  item: ProposalItem;
  counts: ProposalCounts;
}

export type BulkDecision = 'accept' | 'reject' | 'pending';

export type BulkSkipReason =
  | 'not_found'
  | 'sensitive_requires_individual_accept'
  | 'closing_requires_individual_accept';

export interface BulkDecideResult {
  updated: number;
  skipped: Array<{ itemId: string; reason: BulkSkipReason }>;
  counts: ProposalCounts;
}

/** #366's `addItemSchema` (used by #368's "Add to graph"). */
export interface AddProposalItemInput {
  kind: 'entity' | 'relation' | 'item';
  payload: Record<string, unknown>;
  existingEntityId?: string;
  evidence: EvidenceSpanInput[];
}

export interface CommitResult {
  created: { entities: number; relations: number; items: number };
  linked: number;
  evidenceAdded: number;
  closingsApplied: number;
  closingsSkipped: number;
  superseded: number;
  aliasesAdded: number;
  distinctPairsRecorded: number;
  skippedPending: number;
}

export type RevertKeptWhy = 'edited_since' | 'referenced_since' | 'merged_since' | 'evidence_since';

export interface RevertKept {
  kind: 'entity' | 'relation' | 'item' | 'closing' | 'alias' | 'item_change';
  id: string;
  label: string;
  why: RevertKeptWhy;
}

export interface RevertResult {
  reverted: number;
  kept: RevertKept[];
}

export interface ListProposalsParams {
  status?: ProposalStatus;
  kind?: ProposalKind;
  noteId?: string;
  transcriptId?: string;
  cursor?: string;
  limit?: number;
}

/** #363's `requestExtractionSchema`. */
export interface RequestExtractionInput {
  model?: string;
  userGuidance?: Partial<ProposalUserGuidance>;
}

/** #363's `extractionEstimateSchema`. */
export interface ExtractionEstimate {
  providerId: string;
  model: string;
  inputTokens: number;
  maxOutputTokens: number;
  availableInputTokens: number;
  fits: boolean;
  requests: number;
  keyConfigured: boolean;
}

/** #363's `requestExtractionResponseSchema` (202). */
export interface RequestExtractionResult {
  proposal: {
    id: string;
    noteId: string;
    noteVersion: number;
    status: 'extracting';
    model: string;
    providerId: string;
    createdAt: string;
  };
  estimate: ExtractionEstimate;
}

/** #370's entity search row. */
export interface GraphEntitySearchResult {
  id: string;
  type: string;
  label: string;
  aliases: string[];
}

const proposalPath = (id: string) => `/graph/proposals/${encodeURIComponent(id)}`;

/** `GET /api/graph/notes/:noteId/proposal` — the newest non-discarded proposal, or null. */
export async function getNoteProposal(noteId: string): Promise<ProposalDetail | null> {
  const result = await api.get<{ proposal: ProposalDetail | null }>(
    `/graph/notes/${encodeURIComponent(noteId)}/proposal`,
  );
  return result.proposal;
}

/** `GET /api/graph/proposals/:id[?include=context]`. */
export async function getProposal(
  id: string,
  options: { includeContext?: boolean } = {},
): Promise<ProposalDetail> {
  const query = options.includeContext ? '?include=context' : '';
  return api.get<ProposalDetail>(`${proposalPath(id)}${query}`);
}

/** `GET /api/graph/proposals?status&kind&noteId&transcriptId&cursor&limit`. */
export async function listProposals(
  params: ListProposalsParams = {},
): Promise<{ items: ProposalSummary[]; nextCursor: string | null }> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const suffix = query.toString();
  return api.get(`/graph/proposals${suffix ? `?${suffix}` : ''}`);
}

export async function patchProposalItem(
  proposalId: string,
  itemId: string,
  body: PatchProposalItemInput,
): Promise<PatchProposalItemResult> {
  return api.patch<PatchProposalItemResult>(
    `${proposalPath(proposalId)}/items/${encodeURIComponent(itemId)}`,
    body,
  );
}

export async function bulkDecideProposalItems(
  proposalId: string,
  body: { itemIds: string[]; decision: BulkDecision },
): Promise<BulkDecideResult> {
  return api.post<BulkDecideResult>(`${proposalPath(proposalId)}/items/bulk`, body);
}

export async function addProposalItem(
  proposalId: string,
  body: AddProposalItemInput,
): Promise<PatchProposalItemResult> {
  return api.post<PatchProposalItemResult>(`${proposalPath(proposalId)}/items`, body);
}

export async function commitProposal(
  id: string,
): Promise<{ proposal: ProposalSummary; result: CommitResult }> {
  return api.post(`${proposalPath(id)}/commit`, {});
}

export async function discardProposal(id: string): Promise<{ proposal: ProposalSummary }> {
  return api.post(`${proposalPath(id)}/discard`, {});
}

export async function revertProposal(
  id: string,
  options: { confirmPartial: boolean },
): Promise<{ proposal: ProposalSummary; result: RevertResult }> {
  return api.post(`${proposalPath(id)}/revert`, { confirmPartial: options.confirmPartial });
}

/** `POST /api/graph/notes/:noteId/extract` — 202 with the extracting proposal. */
export async function requestExtraction(
  noteId: string,
  body: RequestExtractionInput = {},
): Promise<RequestExtractionResult> {
  return api.post<RequestExtractionResult>(
    `/graph/notes/${encodeURIComponent(noteId)}/extract`,
    body,
  );
}

/** `GET /api/graph/entities?type&q&limit` (#370) — the re-link search. */
export async function searchGraphEntities(params: {
  type?: string;
  q: string;
  limit?: number;
}): Promise<GraphEntitySearchResult[]> {
  const query = new URLSearchParams({ q: params.q, limit: String(params.limit ?? 10) });
  if (params.type) query.set('type', params.type);
  const result = await api.get<{ items: GraphEntitySearchResult[]; nextCursor: string | null }>(
    `/graph/entities?${query.toString()}`,
  );
  return result.items;
}

/**
 * `GRAPH_CONFLICT_REASONS` (`apps/api/src/graph/graph-conflict-reasons.ts`)
 * plus the two #366 appends. Typed `| string` at the edge: a newer server may
 * send a reason this build does not know, and that must not be coerced.
 */
export type GraphConflictReason =
  | 'graph_disabled'
  | 'ai_not_configured'
  | 'ai_key_missing'
  | 'extraction_running'
  | 'proposal_not_draft'
  | 'stale_note_version'
  | 'revert_conflict'
  | 'model_lacks_capability'
  | 'note_not_ready'
  | 'proposal_not_committed'
  | 'stale_segment_rev';

/** `details.reason` of a graph 409, like `noteConflictReason`. */
export function graphConflictReason(err: unknown): GraphConflictReason | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const details = err.details;
  if (typeof details !== 'object' || details === null) return null;
  const reason = (details as { reason?: unknown }).reason;
  return typeof reason === 'string' ? (reason as GraphConflictReason) : null;
}

/** `details.conflicts` of a 409 `revert_conflict`. */
export function revertConflictDetails(
  err: unknown,
): { conflicts: RevertKept[]; revertible: number } | null {
  if (graphConflictReason(err) !== 'revert_conflict') return null;
  const details = (err as ApiError).details as { conflicts?: unknown; revertible?: unknown };
  return {
    conflicts: Array.isArray(details.conflicts) ? (details.conflicts as RevertKept[]) : [],
    revertible: typeof details.revertible === 'number' ? details.revertible : 0,
  };
}

/** `details.issues` of a 400 — Zod issues, each with a `path`. */
export function graphValidationIssues(
  err: unknown,
): Array<{ path: Array<string | number>; message: string }> {
  if (!(err instanceof ApiError) || err.status !== 400) return [];
  const details = err.details as { issues?: unknown } | undefined;
  if (!details || !Array.isArray(details.issues)) return [];
  return details.issues
    .filter((issue): issue is { path?: unknown; message?: unknown } => typeof issue === 'object' && issue !== null)
    .map((issue) => ({
      path: Array.isArray(issue.path) ? (issue.path as Array<string | number>) : [],
      message: typeof issue.message === 'string' ? issue.message : 'Invalid value',
    }));
}
