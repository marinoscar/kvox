import { z } from 'zod';

// =============================================================================
// Possible-duplicates DTOs (issue #766)
// =============================================================================
//
// `GET /api/graph/duplicates` lists pairs of the caller's live entities that
// probably are one thing (a fast name pass plus the open `resolution`
// proposals); `POST /api/graph/duplicates/scan` queues the deeper `kg.resolve`
// re-scan. Both are the caller's own data.
// =============================================================================

/**
 * Wire constant: why a pair is listed as a possible duplicate.
 *
 * @stability experimental
 */
export const DUPLICATE_REASONS = [
  'name_contained',
  'initials',
  'alias_match',
  'similar_name',
  'resolution_proposal',
] as const;

/**
 * Wire constant: where a possible-duplicate pair came from.
 *
 * @stability experimental
 */
export const DUPLICATE_SOURCES = ['name_pass', 'resolution_proposal'] as const;

/**
 * Zod schema for the query of `GET /api/graph/duplicates`.
 *
 * @stability experimental
 */
export const listDuplicatesQuerySchema = z.object({
  type: z.string().trim().min(1).max(100).optional().describe('Only pairs of this entity type.'),
  limit: z.coerce.number().int().min(1).max(200).default(50).describe('Most pairs returned, best first.'),
});

/**
 * The parsed shape of {@link listDuplicatesQuerySchema}.
 *
 * @stability experimental
 */
export type ListDuplicatesQuery = z.infer<typeof listDuplicatesQuerySchema>;

/**
 * Zod schema for one side of a possible-duplicate pair.
 *
 * @stability experimental
 */
export const duplicateEntitySchema = z.object({
  id: z.guid(),
  type: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).describe('Other names the entity is known by (the label itself excluded).'),
  mentionCount: z.number().int().describe('How many times the entity is mentioned in your notes and transcripts.'),
});

/**
 * Zod schema for one possible-duplicate pair.
 *
 * @stability experimental
 */
export const duplicatePairSchema = z.object({
  a: duplicateEntitySchema,
  b: duplicateEntitySchema,
  score: z.number().min(0).max(1).describe('How likely the two are one entity. Deterministic for the same names.'),
  reasons: z.array(z.enum(DUPLICATE_REASONS)).describe('Every signal that fired.'),
  source: z.enum(DUPLICATE_SOURCES),
  proposalItemId: z.guid().optional().describe('The open resolution-proposal row that suggests this merge (source `resolution_proposal`).'),
});

/**
 * The parsed shape of {@link duplicatePairSchema}.
 *
 * @stability experimental
 */
export type DuplicatePair = z.infer<typeof duplicatePairSchema>;

/**
 * Zod schema for the response of `GET /api/graph/duplicates`.
 *
 * @stability experimental
 */
export const listDuplicatesResponseSchema = z.object({
  pairs: z.array(duplicatePairSchema).describe('Best score first.'),
});

/**
 * The parsed shape of {@link listDuplicatesResponseSchema}.
 *
 * @stability experimental
 */
export type ListDuplicatesResponse = z.infer<typeof listDuplicatesResponseSchema>;

/**
 * Zod schema for the response of `POST /api/graph/duplicates/scan`.
 *
 * @stability experimental
 */
export const duplicatesScanResponseSchema = z.object({
  queued: z.literal(true),
  alreadyRunning: z.boolean().describe('True when a `kg.resolve` run was already pending or running and this request joined it.'),
  jobId: z.guid().describe('The queued `kg.resolve` job, or the run this request joined.'),
});

/**
 * The parsed shape of {@link duplicatesScanResponseSchema}.
 *
 * @stability experimental
 */
export type DuplicatesScanResponse = z.infer<typeof duplicatesScanResponseSchema>;
