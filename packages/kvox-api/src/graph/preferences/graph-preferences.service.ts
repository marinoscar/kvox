// =============================================================================
// GraphPreferencesService (#369, epic #346, docs/specs/ontology.md §7, §13, §17.2)
// =============================================================================
//
// One user's resolved connected-knowledge preferences, read from the `graph`
// user-settings namespace and filled from `GRAPH_PREFERENCE_DEFAULTS`. The
// single read path extraction (#363), resolution (#364) and the effective
// ontology (`GraphOntologyService.enabledDomains`) consult.
//
// A PLAIN READ through the settings port (`KVOX_SETTINGS.readUser`). A background job
// resolving preferences for a user must not write, and an absent namespace simply means
// every default. Never throws for an absent namespace.
// =============================================================================

import { Inject, Injectable } from '@nestjs/common';

import { KVOX_SETTINGS, type KvoxSettingsPort } from '../../ports/index.js';
import {
  resolveGraphPreferences,
  type GraphPreferences,
} from './graph-preferences.defaults.js';
import type { GraphPreferencesValue } from './graph-preferences.schema.js';

export {
  GRAPH_PREFERENCE_DEFAULTS,
  resolveGraphPreferences,
  enabledDomainKeys,
  type GraphPreferences,
} from './graph-preferences.defaults.js';

/**
 * GraphPreferencesService: wiring the slice registers itself; a host configures it through `GraphModule.forRoot` and never calls it directly.
 *
 * @internal
 * @stability experimental
 */
@Injectable()
export class GraphPreferencesService {
  constructor(@Inject(KVOX_SETTINGS) private readonly settings: KvoxSettingsPort) {}

  /** One user's resolved preferences. */
  async get(userId: string): Promise<GraphPreferences> {
    const value = await this.settings.readUser<GraphPreferencesValue | undefined>(userId, 'graph');
    return resolveGraphPreferences(value ?? undefined);
  }
}
