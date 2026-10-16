import { z } from 'zod';

// =============================================================================
// Graph resolution DTOs (#364, epic #346; docs/specs/ontology.md §7, §12)
// =============================================================================
//
// `POST /api/graph/entities/:id/merge`, `POST /api/graph/merges/:id/reverse`,
// `POST /api/graph/distinct-pairs`. Every body is `.strict()`: an unknown key
// is a 400, never silently ignored.
// =============================================================================

/**
 * Zod schema for the merge entity body wire shape.
 *
 * @stability experimental
 */
export const mergeEntityBodySchema = z
  .object({
    intoId: z.guid().describe('The entity that survives. `:id` is merged INTO it and becomes a tombstone.'),
  })
  .strict();
/**
 * The parsed shape of {@link mergeEntityBodySchema}.
 *
 * @stability experimental
 */
export type MergeEntityBody = z.infer<typeof mergeEntityBodySchema>;

/**
 * Zod schema for the merge entity response wire shape.
 *
 * @stability experimental
 */
export const mergeEntityResponseSchema = z
  .object({
    merge: z.object({
      id: z.guid().describe('The merge record — pass it to `POST /api/graph/merges/{id}/reverse` to undo.'),
      survivorId: z.guid(),
      mergedId: z.guid(),
      createdAt: z.string().describe('ISO 8601.'),
    }),
    survivor: z.object({
      id: z.guid(),
      type: z.string(),
      label: z.string(),
      aliasCount: z.number().int().describe('Aliases the survivor has now — the merged entity\'s label and aliases included.'),
    }),
  })
  .describe('The merge, and the entity that survived it.');
/**
 * The parsed shape of {@link mergeEntityResponseSchema}.
 *
 * @stability experimental
 */
export type MergeEntityResponse = z.infer<typeof mergeEntityResponseSchema>;

/**
 * Zod schema for the reverse merge body wire shape.
 *
 * @stability experimental
 */
export const reverseMergeBodySchema = z.object({}).strict();

/**
 * Zod schema for the reverse merge response wire shape.
 *
 * @stability experimental
 */
export const reverseMergeResponseSchema = z
  .object({
    merge: z.object({
      id: z.guid(),
      survivorId: z.guid(),
      mergedId: z.guid(),
      reversedAt: z.string().describe('ISO 8601.'),
    }),
    restored: z.object({ id: z.guid(), type: z.string(), label: z.string() }),
    skipped: z
      .array(
        z.object({
          kind: z.enum(['relation', 'item', 'evidence', 'mention', 'alias']),
          id: z.guid(),
          why: z.enum(['deleted_since', 'moved_since', 'changed_since']),
        }),
      )
      .describe('Rows the merge moved that could not be given back: deleted since, or moved elsewhere since — or (`changed_since`, #445) a kept relation whose prop the merge filled in was edited since, so that value stays.'),
  })
  .describe('The reversed merge and the entity it restored.');
/**
 * The parsed shape of {@link reverseMergeResponseSchema}.
 *
 * @stability experimental
 */
export type ReverseMergeResponse = z.infer<typeof reverseMergeResponseSchema>;

/**
 * Zod schema for the distinct pair body wire shape.
 *
 * @stability experimental
 */
export const distinctPairBodySchema = z
  .object({
    aId: z.guid().describe('One entity. Order does not matter.'),
    bId: z.guid().describe('The other entity.'),
  })
  .strict();
/**
 * The parsed shape of {@link distinctPairBodySchema}.
 *
 * @stability experimental
 */
export type DistinctPairBody = z.infer<typeof distinctPairBodySchema>;

/**
 * Zod schema for the distinct pair response wire shape.
 *
 * @stability experimental
 */
export const distinctPairResponseSchema = z
  .object({
    aId: z.guid().describe('The pair, normalized so `aId < bId`.'),
    bId: z.guid(),
    created: z.boolean().describe('`false` when the pair was already recorded — recording it again changes nothing.'),
  })
  .describe('A confirmed "not the same" pair. Resolution never proposes it as a match again.');
/**
 * The parsed shape of {@link distinctPairResponseSchema}.
 *
 * @stability experimental
 */
export type DistinctPairResponse = z.infer<typeof distinctPairResponseSchema>;
