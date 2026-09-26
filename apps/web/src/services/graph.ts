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
