// =============================================================================
// GraphPreferencesService (#369, epic #346, docs/specs/ontology.md §7, §13, §17.2)
// =============================================================================
//
// One user's resolved connected-knowledge preferences, read from the `graph`
// user-settings namespace and filled from `GRAPH_PREFERENCE_DEFAULTS`. The
// single read path extraction (#363), resolution (#364) and the effective
// ontology (`GraphOntologyService.enabledDomains`) consult.
//
// A PLAIN READ. It never creates a `user_settings` row (unlike
// `UserSettingsService.getSettings`, which inserts defaults for a new user):
// a background job resolving preferences for a user must not write, and an
// absent row simply means every default. Never throws for an absent row.
// =============================================================================

import { Injectable } from '@nestjs/common';

import type { UserSettingsValue } from '../../common/types/settings.types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  resolveGraphPreferences,
  type GraphPreferences,
} from './graph-preferences.defaults';

export {
  GRAPH_PREFERENCE_DEFAULTS,
  resolveGraphPreferences,
  enabledDomainKeys,
  type GraphPreferences,
} from './graph-preferences.defaults';

@Injectable()
export class GraphPreferencesService {
  constructor(private readonly prisma: PrismaService) {}

  async get(userId: string): Promise<GraphPreferences> {
    const row = await this.prisma.userSettings.findUnique({
      where: { userId },
      select: { value: true },
    });
    const value = row?.value as unknown as UserSettingsValue | null | undefined;
    return resolveGraphPreferences(value?.graph);
  }
}
