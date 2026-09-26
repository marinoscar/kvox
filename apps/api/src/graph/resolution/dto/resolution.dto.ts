import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Graph resolution DTOs (#364, epic #346; docs/specs/ontology.md §7, §12)
// =============================================================================
//
// `POST /api/graph/entities/:id/merge`, `POST /api/graph/merges/:id/reverse`,
// `POST /api/graph/distinct-pairs`. Every body is `.strict()`: an unknown key
// is a 400, never silently ignored.
// =============================================================================

export const mergeEntityBodySchema = z
  .object({
    intoId: z.guid().describe('The entity that survives. `:id` is merged INTO it and becomes a tombstone.'),
  })
  .strict();
export type MergeEntityBody = z.infer<typeof mergeEntityBodySchema>;
export class MergeEntityBodyDto extends createZodDto(mergeEntityBodySchema) {}

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
export type MergeEntityResponse = z.infer<typeof mergeEntityResponseSchema>;
export class MergeEntityResponseDto extends createZodDto(mergeEntityResponseSchema) {}

export const reverseMergeBodySchema = z.object({}).strict();
export class ReverseMergeBodyDto extends createZodDto(reverseMergeBodySchema) {}

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
          why: z.enum(['deleted_since', 'moved_since']),
        }),
      )
      .describe('Rows the merge moved that could not be given back: deleted since, or moved elsewhere since.'),
  })
  .describe('The reversed merge and the entity it restored.');
export type ReverseMergeResponse = z.infer<typeof reverseMergeResponseSchema>;
export class ReverseMergeResponseDto extends createZodDto(reverseMergeResponseSchema) {}

export const distinctPairBodySchema = z
  .object({
    aId: z.guid().describe('One entity. Order does not matter.'),
    bId: z.guid().describe('The other entity.'),
  })
  .strict();
export type DistinctPairBody = z.infer<typeof distinctPairBodySchema>;
export class DistinctPairBodyDto extends createZodDto(distinctPairBodySchema) {}

export const distinctPairResponseSchema = z
  .object({
    aId: z.guid().describe('The pair, normalized so `aId < bId`.'),
    bId: z.guid(),
    created: z.boolean().describe('`false` when the pair was already recorded — recording it again changes nothing.'),
  })
  .describe('A confirmed "not the same" pair. Resolution never proposes it as a match again.');
export type DistinctPairResponse = z.infer<typeof distinctPairResponseSchema>;
export class DistinctPairResponseDto extends createZodDto(distinctPairResponseSchema) {}
