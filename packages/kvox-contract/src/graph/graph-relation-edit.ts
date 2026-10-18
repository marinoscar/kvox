import { z } from 'zod';

// =============================================================================
// Manual relation edits (#586; docs/specs/ontology.md §5.2, §5.4, §8)
// =============================================================================
//
// `POST   /api/graph/entities/:id/relations`              — set a manager, an
//                                                          employer or a role
// `DELETE /api/graph/entities/:id/relations/:relationId`  — remove a wrong one
//
// Part of §8's second named exception (the manual edit on an entity page):
// the owner states a work relation of a Person by hand. The write runs through
// `GraphWriteService` like every other, and the relation carries one
// SERVER-AUTHORED citation — the owner as the source (`kind: 'manual'` in an
// evidence link) — so the no-orphans invariant holds. A client never sends
// that citation and cannot send it anywhere else: `evidenceInputSchema`
// refuses the reserved `MANUAL_EVIDENCE_SOURCE_IRI`.
// =============================================================================

/**
 * The relation types a manual relation edit may write, all from a Person:
 * `REPORTS_TO` (→ Person), `WORKS_FOR` (→ Organization), `HAS_ROLE`
 * (→ Organization, with a title). Each is temporal and normally exclusive
 * (§5.4), so setting one closes the person's still-open edge of that type.
 *
 * @stability experimental
 */
export const MANUAL_RELATION_TYPES = ['REPORTS_TO', 'WORKS_FOR', 'HAS_ROLE'] as const;

/**
 * One of {@link MANUAL_RELATION_TYPES}.
 *
 * @stability experimental
 */
export type ManualRelationType = (typeof MANUAL_RELATION_TYPES)[number];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Zod schema for the body of `POST /api/graph/entities/:id/relations`.
 *
 * @stability experimental
 */
export const createManualRelationSchema = z
  .object({
    type: z.enum(MANUAL_RELATION_TYPES).describe('`REPORTS_TO`, `WORKS_FOR` or `HAS_ROLE`.'),
    toId: z.uuid().describe('The other end: a Person for `REPORTS_TO`, an Organization for `WORKS_FOR` and `HAS_ROLE`.'),
    props: z
      .object({
        title: z.string().trim().min(1).max(200).describe('The role title.'),
        businessUnit: z.string().trim().min(1).max(200).nullable().optional().describe('The business unit, when there is one.'),
      })
      .strict()
      .optional()
      .describe('`HAS_ROLE` only, and required there.'),
    validFrom: z
      .string()
      .regex(ISO_DAY, 'Use YYYY-MM-DD.')
      .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v), 'Not a real date.')
      .optional()
      .describe('Since when (`YYYY-MM-DD`, day precision). Default: today (UTC).'),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (v.type === 'HAS_ROLE' && !v.props) {
      ctx.addIssue({ code: 'custom', path: ['props'], message: 'A role needs a title.' });
    }
    if (v.type !== 'HAS_ROLE' && v.props) {
      ctx.addIssue({ code: 'custom', path: ['props'], message: `${v.type} takes no props.` });
    }
  });

/**
 * The parsed shape of {@link createManualRelationSchema}.
 *
 * @stability experimental
 */
export type CreateManualRelationDto = z.infer<typeof createManualRelationSchema>;

/**
 * Zod schema for one relation as a manual relation edit returns it.
 *
 * @stability experimental
 */
export const manualRelationSchema = z.object({
  id: z.uuid(),
  type: z.string(),
  fromId: z.uuid(),
  toId: z.uuid(),
  props: z.record(z.string(), z.unknown()),
  valid: z
    .object({ from: z.string().nullable(), to: z.string().nullable(), precision: z.enum(['day', 'month', 'year', 'unknown']) })
    .nullable()
    .describe('Half-open `[from, to)`, ISO 8601.'),
  reviewStatus: z.string(),
});

/**
 * The parsed shape of {@link manualRelationSchema}.
 *
 * @stability experimental
 */
export type ManualRelation = z.infer<typeof manualRelationSchema>;

/**
 * Zod schema for the response of `POST /api/graph/entities/:id/relations`.
 *
 * @stability experimental
 */
export const createManualRelationResponseSchema = z
  .object({
    relation: manualRelationSchema.describe('The relation that now holds the fact: the new one, or the existing one the fact restated.'),
    created: z.boolean().describe('False when the same fact was already in your graph: the citation was added to it instead.'),
    evidenceId: z.uuid().describe('The citation this edit added (its source kind is `manual`).'),
    closedRelationIds: z
      .array(z.uuid())
      .describe('Still-open edges of the same type this one closed at its start (§5.4 closing rule), sorted.'),
    flags: z
      .array(z.enum(['overlaps', 'unordered']))
      .describe('Soft warnings: `unordered` — an undated edge of the same type stays open (remove it if it is wrong); `overlaps` — the new range overlaps another edge.'),
  })
  .describe('What a manual relation edit wrote.');

/**
 * The parsed shape of {@link createManualRelationResponseSchema}.
 *
 * @stability experimental
 */
export type CreateManualRelationResponse = z.infer<typeof createManualRelationResponseSchema>;

/**
 * Zod schema for the response of `DELETE /api/graph/entities/:id/relations/:relationId`.
 *
 * @stability experimental
 */
export const removeManualRelationResponseSchema = z
  .object({
    relationId: z.uuid(),
    reviewStatus: z.literal('rejected').describe('Kept for the record and never read again (§5.5); its range is left as it was, because the fact was never true.'),
    reopenedRelationIds: z
      .array(z.uuid())
      .describe('Edges this relation had closed when it was set, open again now that it is gone, sorted.'),
  })
  .describe('A relation removed as wrong.');

/**
 * The parsed shape of {@link removeManualRelationResponseSchema}.
 *
 * @stability experimental
 */
export type RemoveManualRelationResponse = z.infer<typeof removeManualRelationResponseSchema>;
