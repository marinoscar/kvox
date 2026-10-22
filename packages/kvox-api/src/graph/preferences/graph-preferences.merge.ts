// =============================================================================
// The `graph` user settings merge rules (issue #459, issue #369, epic #346; moved by #496)
// =============================================================================
//
// One user's preferences over their OWN connected-knowledge graph
// (docs/specs/ontology.md §7, §13, §17.2). The rules live HERE, beside the slice that owns
// them; the web edition declares the namespace with the platform's settings registry in
// `apps/api/src/kvox/graph/graph.user-settings.ts` (registered by
// `app-registrations/settings.ts`), which is where the platform's `UserSettingsNamespace`
// shape is known. The platform composes it into `GET/PUT/PATCH /api/user-settings`.
//
// The schemas live in `graph-preferences.schema.ts`. `merge` is
// `UserSettingsService.mergeGraph` moved VERBATIM, and `assertLimits` throws
// the same `BadRequestException` text it throws today, so an out-of-order
// threshold pair still answers 400 with the same message.
//
// ABSENT MEANS "DEFAULTS": no `.default()` anywhere; registration refuses one.
// =============================================================================

import { BadRequestException } from '@nestjs/common';

import { GRAPH_PREFERENCE_DEFAULTS } from './graph-preferences.defaults.js';
import {
  GRAPH_THRESHOLD_ORDER_MESSAGE,
  graphPreferencesPatchSchema,
  graphPreferencesSchema,
  graphThresholdsAreOrdered,
  type GraphPreferencesPatchValue,
  type GraphPreferencesValue,
} from './graph-preferences.schema.js';

/** A patch field's value: `undefined` keeps `current`, `null` restores `fallback`, anything else replaces. */
function pick<T>(patch: T | null | undefined, current: T, fallback: T): T {
  if (patch === undefined) return current;
  if (patch === null) return fallback;
  return patch;
}

/**
 * Merge the `graph` namespace (#369, epic #346) per sub-object.
 *
 *   `patch === undefined`          = keep what is stored
 *   `patch === null`               = delete the namespace (every default)
 *   `patch.<sub> === null`         = delete that sub-object (its defaults)
 *   `patch.<sub>.<field> === null` = that field back to its default
 *
 * A sub-object is stored WHOLE (every field present — see the namespace
 * header), so a patch that creates one fills the fields it does not name
 * from `GRAPH_PREFERENCE_DEFAULTS`. That is what makes the threshold-order
 * rule checkable against the merged value, which is done here with an
 * explicit 400: a patch naming only `autoLinkThreshold: 0.8` is valid on its
 * own and invalid against a stored `newThreshold: 0.8`, and the ZodError
 * `userSettingsSchema.parse` would otherwise throw escapes as a 500.
 *
 * @internal
 */
export function mergeGraphPreferences(
  current: GraphPreferencesValue | undefined,
  patch: GraphPreferencesPatchValue | null | undefined,
): GraphPreferencesValue | undefined {
  if (patch === undefined) {
    return current;
  }

  if (patch === null) {
    return undefined;
  }

  const merged: GraphPreferencesValue = { ...(current ?? {}) };
  const defaults = GRAPH_PREFERENCE_DEFAULTS;

  if (patch.extraction === null) {
    delete merged.extraction;
  } else if (patch.extraction !== undefined) {
    const base = merged.extraction ?? { ...defaults.extraction };
    merged.extraction = {
      autoExtract: pick(
        patch.extraction.autoExtract,
        base.autoExtract,
        defaults.extraction.autoExtract,
      ),
    };
  }

  if (patch.resolution === null) {
    delete merged.resolution;
  } else if (patch.resolution !== undefined) {
    const base = merged.resolution ?? { ...defaults.resolution };
    const next = {
      mode: pick(patch.resolution.mode, base.mode, defaults.resolution.mode),
      autoLinkThreshold: pick(
        patch.resolution.autoLinkThreshold,
        base.autoLinkThreshold,
        defaults.resolution.autoLinkThreshold,
      ),
      newThreshold: pick(
        patch.resolution.newThreshold,
        base.newThreshold,
        defaults.resolution.newThreshold,
      ),
      adjudication: pick(
        patch.resolution.adjudication,
        base.adjudication,
        defaults.resolution.adjudication,
      ),
    };
    if (!graphThresholdsAreOrdered(next.newThreshold, next.autoLinkThreshold)) {
      throw new BadRequestException(
        `graph.resolution: ${GRAPH_THRESHOLD_ORDER_MESSAGE} (would store newThreshold ${next.newThreshold}, autoLinkThreshold ${next.autoLinkThreshold}).`,
      );
    }
    merged.resolution = next;
  }

  if (patch.domains === null) {
    delete merged.domains;
  } else if (patch.domains !== undefined) {
    const base = merged.domains ?? {
      work: defaults.domains.work,
      personal: defaults.domains.personal,
    };
    merged.domains = {
      work: pick(patch.domains.work, base.work, defaults.domains.work),
      personal: pick(
        patch.domains.personal,
        base.personal,
        defaults.domains.personal,
      ),
    };
  }

  // `explorer.lenses` (GIC-17): the whole list is replaced; `null` deletes it (and the empty object).
  if (patch.explorer === null) {
    delete merged.explorer;
  } else if (patch.explorer !== undefined) {
    const lenses = patch.explorer.lenses === undefined ? merged.explorer?.lenses : (patch.explorer.lenses ?? undefined);
    if (lenses === undefined) delete merged.explorer;
    else merged.explorer = { lenses };
  }

  return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Re-checks the threshold order on a MERGED or PUT value and answers a 400.
 *
 * `merge` already throws this for a PATCH (the combination only the merge
 * reveals); this is the same check on the value about to be stored, so the
 * contract holds on every write path. Same text as `merge`.
 *
 * @stability experimental
 */
export function assertGraphPreferenceLimits(value: GraphPreferencesValue | undefined): void {
  const resolution = value?.resolution;
  if (resolution === undefined) {
    return;
  }
  if (!graphThresholdsAreOrdered(resolution.newThreshold, resolution.autoLinkThreshold)) {
    throw new BadRequestException(
      `graph.resolution: ${GRAPH_THRESHOLD_ORDER_MESSAGE} (would store newThreshold ${resolution.newThreshold}, autoLinkThreshold ${resolution.autoLinkThreshold}).`,
    );
  }
}

