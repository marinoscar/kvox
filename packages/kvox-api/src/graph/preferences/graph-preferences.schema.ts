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
    /**
     * The mode.
     */
    mode: graphResolutionModeSchema,
    /**
     * The auto link threshold.
     */
    autoLinkThreshold: graphAutoLinkThresholdSchema,
    /**
     * The new threshold.
     */
    newThreshold: graphNewThresholdSchema,
    /**
     * The adjudication.
     */
    adjudication: graphAdjudicationSchema,
  })
  .strict()
  .refine((r) => graphThresholdsAreOrdered(r.newThreshold, r.autoLinkThreshold), {
    message: GRAPH_THRESHOLD_ORDER_MESSAGE,
    path: ['newThreshold'],
  });

const graphMinConfidenceSchema = z.number().min(0).max(1);

const graphReviewSchema = z
  .object({
    /**
     * The lowest confidence at which the safe policy accepts a row on its own (#717, ADR-0007).
     */
    minConfidence: graphMinConfidenceSchema,
  })
  .strict();

const graphDomainsSchema = z
  .object({
    /**
     * The work.
     */
    work: z.boolean(),
    // Off by default (GRAPH_PREFERENCE_DEFAULTS); #383 ships the domain.
    /**
     * The personal.
     */
    personal: z.boolean(),
  })
  .strict();

// -----------------------------------------------------------------------------
// `graph.explorer.lenses` (GIC-17, #678)
// -----------------------------------------------------------------------------
//
// A LENS is a named bundle of what the explorer shows: seeds, the node and relation types shown,
// the layout and the pinned positions. They are stored per user in this namespace (no table).
// The whole list is replaced by a write; the caps below keep the settings document small:
// at most 20 lenses, 300 pinned positions each, 10 seeds.
// -----------------------------------------------------------------------------

/** Most lenses one user may save. */
export const GRAPH_LENSES_MAX = 20;
/** Most pinned positions one lens may hold. */
export const GRAPH_LENS_PINS_MAX = 300;
/** Most seeds one lens may hold (the explorer's `?seed=` limit). */
export const GRAPH_LENS_SEEDS_MAX = 10;

const graphLensSchema = z
  .object({
    /** A stable id the client chose. */
    id: z.string().trim().min(1).max(64),
    /** The name the user gave it. */
    name: z.string().trim().min(1).max(60),
    /** Entity ids the exploration starts from; empty keeps the seeds already open. */
    seeds: z.array(z.uuid()).max(GRAPH_LENS_SEEDS_MAX),
    /** The node types SHOWN, or `null` for all. */
    types: z.array(z.string().min(1).max(64)).max(200).nullable(),
    /** The relation types SHOWN, or `null` for all. */
    relTypes: z.array(z.string().min(1).max(64)).max(200).nullable(),
    /** The layout, or `null` for the explorer's own choice. */
    layout: z.enum(['force', 'concentric', 'static']).nullable(),
    /** Pinned positions by node id. */
    pins: z
      .record(z.string().min(1).max(80), z.object({ x: z.number().finite(), y: z.number().finite() }).strict())
      .refine((pins) => Object.keys(pins).length <= GRAPH_LENS_PINS_MAX, {
        message: `a lens holds at most ${GRAPH_LENS_PINS_MAX} pinned positions`,
      }),
  })
  .strict();

const graphLensesSchema = z.array(graphLensSchema).max(GRAPH_LENSES_MAX);

const graphExplorerSchema = z.object({ lenses: graphLensesSchema.optional() }).strict();

/**
 * Full `graph` namespace (stored shape, PUT body, response).
 *
 * @internal
 */
export const graphPreferencesSchema = z
  .object({
    /**
     * The extraction.
     */
    extraction: graphExtractionSchema.optional(),
    /**
     * The resolution.
     */
    resolution: graphResolutionSchema.optional(),
    /**
     * The domains.
     */
    domains: graphDomainsSchema.optional(),
    /**
     * The review: how the safe policy of a batch commit behaves (#717).
     */
    review: graphReviewSchema.optional(),
    /**
     * The explorer's saved lenses (GIC-17).
     */
    explorer: graphExplorerSchema.optional(),
  })
  .strict();

/**
 * PATCH form of the `graph` namespace, mirroring `onboardingPatchSchema`.
 *
 *   `graph: null`                           = delete the namespace (all defaults)
 *   `graph: { resolution: null }`           = reset that sub-object to defaults
 *   `graph: { resolution: { mode: null } }` = reset that one field to its default
 *
 * The threshold-order refine can only be checked here when BOTH thresholds are
 * in the patch; the namespace's `merge` (`graph.user-settings.ts`) re-checks the merged value
 * and answers a 400 for a combination only the merge reveals.
 *
 * @internal
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
    review: z
      .object({ minConfidence: graphMinConfidenceSchema.nullable().optional() })
      .strict()
      .nullable()
      .optional(),
    explorer: z
      .object({ lenses: graphLensesSchema.nullable().optional() })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

/**
 * The graph preferences value type.
 *
 * @stability experimental
 */
export type GraphPreferencesValue = z.infer<typeof graphPreferencesSchema>;
/**
 * The graph preferences patch value type.
 *
 * @stability experimental
 */
export type GraphPreferencesPatchValue = z.infer<
  typeof graphPreferencesPatchSchema
>;
