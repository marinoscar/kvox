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

import type { DomainKey } from '@app/shared/ontology';

import type { GraphPreferencesValue } from '../../common/schemas/user-settings-namespaces.schema';

export type GraphResolutionMode = 'precheck_confident' | 'review_all';
export type GraphAdjudication = 'llm' | 'off';

/** One user's fully resolved graph preferences — every field present. */
export interface GraphPreferences {
  readonly extraction: { readonly autoExtract: boolean };
  readonly resolution: {
    readonly mode: GraphResolutionMode;
    readonly autoLinkThreshold: number;
    readonly newThreshold: number;
    readonly adjudication: GraphAdjudication;
  };
  /** `core` is always on and never stored; it is here so callers need no special case. */
  readonly domains: {
    readonly core: true;
    readonly work: boolean;
    readonly personal: boolean;
  };
}

export const GRAPH_PREFERENCE_DEFAULTS: GraphPreferences = Object.freeze({
  extraction: Object.freeze({ autoExtract: true }),
  resolution: Object.freeze({
    mode: 'precheck_confident' as const,
    autoLinkThreshold: 0.9,
    newThreshold: 0.55,
    adjudication: 'llm' as const,
  }),
  domains: Object.freeze({ core: true as const, work: true, personal: false }),
});

/** The sub-objects of the `graph` namespace, in a stable order. */
export const GRAPH_PREFERENCE_SECTIONS = [
  'extraction',
  'resolution',
  'domains',
] as const;
export type GraphPreferenceSection = (typeof GRAPH_PREFERENCE_SECTIONS)[number];

/**
 * Resolve a stored (possibly absent, possibly sparse) `graph` namespace into
 * the full preference set. Never throws; never mutates its argument.
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
    domains: {
      core: true,
      work: value?.domains?.work ?? d.domains.work,
      personal: value?.domains?.personal ?? d.domains.personal,
    },
  };
}

/** The enabled domains as `DomainKey[]`, `core` always first and always present. */
export function enabledDomainKeys(preferences: GraphPreferences): DomainKey[] {
  const keys: DomainKey[] = ['core'];
  if (preferences.domains.work) keys.push('work');
  if (preferences.domains.personal) keys.push('personal');
  return keys;
}

/** Which sub-objects differ between two resolved preference sets. */
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
