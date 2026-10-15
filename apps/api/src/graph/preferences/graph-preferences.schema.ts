import { z } from 'zod';

// =============================================================================
// User Settings Namespace: `graph` (issue #369, epic #346)
// =============================================================================
//
// One user's preferences over their OWN connected-knowledge graph
// (docs/specs/ontology.md §7, §13, §17.2): whether a note is extracted
// automatically, how sure an entity match must be before it arrives
// pre-checked, whether uncertain matches are adjudicated by the AI (a cost on
// the user's own key), and which ontology domains are on.
//
// PER USER, NOT PER DEPLOYMENT. The thresholds are a preference about one's own
// graph; the deployment-wide switch is `ai.graphEnabled` (#360), a system
// setting. `core` is not stored at all — it is always on.
//
// ABSENT MEANS "DEFAULTS". No `.default()` anywhere (see the file header):
// `GraphPreferencesService` / `resolveGraphPreferences` fill every absent
// sub-object and field from `GRAPH_PREFERENCE_DEFAULTS` at read time, so a
// default can change in a later release without a backfill.
//
// SUB-OBJECTS ARE STORED WHOLE. Each present sub-object carries every one of
// its fields (the namespace's `merge`, in `graph.user-settings.ts`, fills a newly created one from the defaults), which
// is what lets the cross-field refine on `resolution` be evaluated against the
// stored value rather than against a fragment.
// =============================================================================

/** Minimum gap between the "new entity" and "auto-link" thresholds (§7). */
export const GRAPH_THRESHOLD_MIN_GAP = 0.05;

export const graphResolutionModeSchema = z.enum([
  'precheck_confident',
  'review_all',
]);
export const graphAdjudicationSchema = z.enum(['llm', 'off']);

const graphAutoLinkThresholdSchema = z.number().min(0.8).max(0.99);
const graphNewThresholdSchema = z.number().min(0.3).max(0.94);

/**
 * Whether `newThreshold` sits far enough below `autoLinkThreshold`.
 *
 * Compared in hundredths, not raw floats: `0.9 - 0.05` is
 * `0.8500000000000001` in IEEE 754, which would reject the exact boundary a
 * slider with `step={0.01}` legitimately produces.
 */
export function graphThresholdsAreOrdered(
  newThreshold: number,
  autoLinkThreshold: number,
): boolean {
  return (
    Math.round(newThreshold * 100) <=
    Math.round((autoLinkThreshold - GRAPH_THRESHOLD_MIN_GAP) * 100)
  );
}

export const GRAPH_THRESHOLD_ORDER_MESSAGE =
  'newThreshold must be at least 0.05 below autoLinkThreshold';

const graphExtractionSchema = z
  .object({
    /** Queue an extraction proposal when a note becomes ready. Default true. */
    autoExtract: z.boolean(),
  })
  .strict();

const graphResolutionSchema = z
  .object({
    mode: graphResolutionModeSchema,
    autoLinkThreshold: graphAutoLinkThresholdSchema,
    newThreshold: graphNewThresholdSchema,
    adjudication: graphAdjudicationSchema,
  })
  .strict()
  .refine((r) => graphThresholdsAreOrdered(r.newThreshold, r.autoLinkThreshold), {
    message: GRAPH_THRESHOLD_ORDER_MESSAGE,
    path: ['newThreshold'],
  });

const graphDomainsSchema = z
  .object({
    work: z.boolean(),
    // Off by default (GRAPH_PREFERENCE_DEFAULTS); #383 ships the domain.
    personal: z.boolean(),
  })
  .strict();

/** Full `graph` namespace (stored shape, PUT body, response). */
export const graphPreferencesSchema = z
  .object({
    extraction: graphExtractionSchema.optional(),
    resolution: graphResolutionSchema.optional(),
    domains: graphDomainsSchema.optional(),
  })
  .strict();

/**
 * PATCH form of the `graph` namespace, mirroring `onboardingPatchSchema`.
 *
 *   `graph: null`                           -> delete the namespace (all defaults)
 *   `graph: { resolution: null }`           -> reset that sub-object to defaults
 *   `graph: { resolution: { mode: null } }` -> reset that one field to its default
 *
 * The threshold-order refine can only be checked here when BOTH thresholds are
 * in the patch; the namespace's `merge` (`graph.user-settings.ts`) re-checks the merged value
 * and answers a 400 for a combination only the merge reveals.
 */
export const graphPreferencesPatchSchema = z
  .object({
    extraction: z
      .object({ autoExtract: z.boolean().nullable().optional() })
      .strict()
      .nullable()
      .optional(),
    resolution: z
      .object({
        mode: graphResolutionModeSchema.nullable().optional(),
        autoLinkThreshold: graphAutoLinkThresholdSchema.nullable().optional(),
        newThreshold: graphNewThresholdSchema.nullable().optional(),
        adjudication: graphAdjudicationSchema.nullable().optional(),
      })
      .strict()
      .refine(
        (r) =>
          typeof r.newThreshold !== 'number' ||
          typeof r.autoLinkThreshold !== 'number' ||
          graphThresholdsAreOrdered(r.newThreshold, r.autoLinkThreshold),
        { message: GRAPH_THRESHOLD_ORDER_MESSAGE, path: ['newThreshold'] },
      )
      .nullable()
      .optional(),
    domains: z
      .object({
        work: z.boolean().nullable().optional(),
        personal: z.boolean().nullable().optional(),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export type GraphPreferencesValue = z.infer<typeof graphPreferencesSchema>;
export type GraphPreferencesPatchValue = z.infer<
  typeof graphPreferencesPatchSchema
>;
