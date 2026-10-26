import { z } from 'zod';

// =============================================================================
// Personal synonym dictionary DTOs (issue #767)
// =============================================================================
//
// `/api/graph/synonyms`: the caller's own groups of names that mean the same
// thing ("OAC" = "Org Alpha Consulting"). The contract validates SHAPE only; the server
// normalizes (`normalizeAlias`), de-duplicates and checks the entity type
// against the caller's effective ontology.
// =============================================================================

/** Wire constant: fewest terms in a synonym group. @stability experimental */
export const SYNONYM_MIN_TERMS = 2;
/** Wire constant: most terms in a synonym group. @stability experimental */
export const SYNONYM_MAX_TERMS = 20;
/** Wire constant: most synonym groups one user may keep. @stability experimental */
export const SYNONYM_MAX_GROUPS = 500;

const termsSchema = z
  .array(z.string().trim().min(1).max(120))
  .min(SYNONYM_MIN_TERMS)
  .max(SYNONYM_MAX_TERMS)
  .describe('Names that mean the same thing. At least two must stay distinct once normalized (case, spacing and edge punctuation ignored).');

const entityTypeSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .nullable()
  .optional()
  .describe('An entity type key of your effective schema; the group then applies only to that type. Omit or null for every type.');

/**
 * Zod schema for the body of `POST /api/graph/synonyms`.
 *
 * @stability experimental
 */
export const createSynonymGroupSchema = z.object({ terms: termsSchema, entityType: entityTypeSchema });

/**
 * The parsed shape of {@link createSynonymGroupSchema}.
 *
 * @stability experimental
 */
export type CreateSynonymGroupDto = z.infer<typeof createSynonymGroupSchema>;

/**
 * Zod schema for the body of `PATCH /api/graph/synonyms/{id}`: the same shape, replacing the group's terms.
 *
 * @stability experimental
 */
export const updateSynonymGroupSchema = createSynonymGroupSchema;

/**
 * The parsed shape of {@link updateSynonymGroupSchema}.
 *
 * @stability experimental
 */
export type UpdateSynonymGroupDto = z.infer<typeof updateSynonymGroupSchema>;

/**
 * Zod schema for one synonym group.
 *
 * @stability experimental
 */
export const synonymGroupSchema = z.object({
  id: z.guid(),
  terms: z.array(z.string()),
  entityType: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * The parsed shape of {@link synonymGroupSchema}.
 *
 * @stability experimental
 */
export type SynonymGroup = z.infer<typeof synonymGroupSchema>;

/**
 * Zod schema for the response of `GET /api/graph/synonyms`.
 *
 * @stability experimental
 */
export const listSynonymGroupsResponseSchema = z.object({ groups: z.array(synonymGroupSchema) });

/**
 * The parsed shape of {@link listSynonymGroupsResponseSchema}.
 *
 * @stability experimental
 */
export type ListSynonymGroupsResponse = z.infer<typeof listSynonymGroupsResponseSchema>;
