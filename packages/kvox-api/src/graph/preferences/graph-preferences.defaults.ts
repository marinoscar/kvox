// =============================================================================
// Graph preference defaults + the pure resolver (#369, epic #346)
// =============================================================================
//
// docs/specs/ontology.md §7 (thresholds, adjudication), §13 (the card),
// §17.2 (domains). PURE: no Nest, no Prisma — imported by both
// `UserSettingsService` (to fill a newly created sub-object in `mergeGraph`)
// and `GraphPreferencesService` (to resolve a stored value at read time), and
// safe to import from any reducer, prompt builder or test.
//
// The stored `graph` user-settings namespace is SPARSE: an absent sub-object
// or field means "the default below". Defaults therefore live here, in code,
// and never in a user's row — changing one in a later release changes it for
// every user who never chose otherwise, with no backfill.
// =============================================================================

import type { DomainKey } from '@marinoscar/kvox-contract/ontology';

import type { GraphPreferencesValue } from './graph-preferences.schema.js';

/**
 * The graph resolution mode type.
 *
 * @stability experimental
 */
export type GraphResolutionMode = 'precheck_confident' | 'review_all';
/**
 * The graph adjudication type.
 *
 * @stability experimental
 */
export type GraphAdjudication = 'llm' | 'off';

/**
 * The extraction preferences.
 *
 * @stability experimental
 */
export interface GraphExtractionPreferences {
  /** Whether a ready note is extracted automatically. */
  readonly autoExtract: boolean;
}

/** One user's fully resolved graph preferences — every field present. */
/**
 * GraphPreferences.
 *
 * @stability experimental
 */
export interface GraphPreferences {
  /** The extraction preferences. */
  readonly extraction: GraphExtractionPreferences;
  /**
   * The resolution.
   */
  readonly resolution: {
    /**
     * The mode.
     */
    readonly mode: GraphResolutionMode;
    /**
     * The auto link threshold.
     */
    readonly autoLinkThreshold: number;
    /**
     * The new threshold.
     */
    readonly newThreshold: number;
    /**
     * The adjudication.
     */
    readonly adjudication: GraphAdjudication;
  };
  /** The review preferences (#717). */
  readonly review: {
    /**
     * Rows below this confidence are never accepted by the safe policy of a batch
     * commit or an auto-commit. 0.7 sits between `newThreshold` (0.55) and
     * `autoLinkThreshold` (0.9): a link a person would still glance at waits.
     */
    readonly minConfidence: number;
  };
  /** `core` is always on and never stored; it is here so callers need no special case. */
  readonly domains: {
    /**
     * The core.
     */
    readonly core: true;
    /**
     * The work.
     */
    readonly work: boolean;
    /**
     * The personal.
     */
    readonly personal: boolean;
  };
}

/**
 * The graph preference defaults.
 *
 * @stability experimental
 */
export const GRAPH_PREFERENCE_DEFAULTS: GraphPreferences = Object.freeze({
  extraction: Object.freeze({ autoExtract: true }),
  resolution: Object.freeze({
    mode: 'precheck_confident' as const,
    autoLinkThreshold: 0.9,
    newThreshold: 0.55,
    adjudication: 'llm' as const,
  }),
  review: Object.freeze({ minConfidence: 0.7 }),
  domains: Object.freeze({ core: true as const, work: true, personal: false }),
});

/** The sub-objects of the `graph` namespace, in a stable order. */
/**
 * GRAPH_PREFERENCE_SECTIONS.
 *
 * @stability experimental
 */
export const GRAPH_PREFERENCE_SECTIONS = [
  'extraction',
  'resolution',
  'review',
  'domains',
] as const;
/**
 * The graph preference section type.
 *
 * @stability experimental
 */
export type GraphPreferenceSection = (typeof GRAPH_PREFERENCE_SECTIONS)[number];

/**
 * Resolve a stored (possibly absent, possibly sparse) `graph` namespace into
 * the full preference set. Never throws; never mutates its argument.
 *
 * @stability experimental
 */
export function resolveGraphPreferences(
  value: GraphPreferencesValue | null | undefined,
): GraphPreferences {
  const d = GRAPH_PREFERENCE_DEFAULTS;
  return {
    extraction: {
      autoExtract: value?.extraction?.autoExtract ?? d.extraction.autoExtract,
    },
    resolution: {
      mode: value?.resolution?.mode ?? d.resolution.mode,
      autoLinkThreshold:
        value?.resolution?.autoLinkThreshold ?? d.resolution.autoLinkThreshold,
      newThreshold: value?.resolution?.newThreshold ?? d.resolution.newThreshold,
      adjudication: value?.resolution?.adjudication ?? d.resolution.adjudication,
    },
    review: {
      minConfidence: value?.review?.minConfidence ?? d.review.minConfidence,
    },
    domains: {
      core: true,
      work: value?.domains?.work ?? d.domains.work,
      personal: value?.domains?.personal ?? d.domains.personal,
    },
  };
}

/**
 * The enabled domains as `DomainKey[]`, `core` always first and always present.
 *
 * @param preferences - the user's resolved preferences.
 * @returns the enabled domain keys.
 * @stability experimental
 */
export function enabledDomainKeys(preferences: GraphPreferences): DomainKey[] {
  const keys: DomainKey[] = ['core'];
  if (preferences.domains.work) keys.push('work');
  if (preferences.domains.personal) keys.push('personal');
  return keys;
}

/** Which sub-objects differ between two resolved preference sets. */
/**
 * changedGraphSections.
 *
 * @stability experimental
 */
export function changedGraphSections(
  previous: GraphPreferences,
  next: GraphPreferences,
): GraphPreferenceSection[] {
  return GRAPH_PREFERENCE_SECTIONS.filter((section) => {
    const a = previous[section] as Record<string, unknown>;
    const b = next[section] as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    return [...keys].some((key) => a[key] !== b[key]);
  });
}
