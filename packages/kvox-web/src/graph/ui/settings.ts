import HubOutlinedIcon from '@mui/icons-material/HubOutlined';

import type { KvoxSettingsCard } from '../../core/ui/index.js';

/**
 * The per-user settings cards of the graph slice, by hub group.
 *
 * @stability experimental
 */
export interface KvoxGraphUserSettingsSections {
  /** The cards of the `Knowledge` group, in order. */
  readonly knowledge: readonly KvoxSettingsCard[];
}

/**
 * The user settings cards of the graph slice, as data: the app spreads
 * `kvoxGraphUserSettingsSections.knowledge` into its own `Knowledge` group,
 * which sits between `Account` and `Security`.
 *
 * @stability experimental
 * @extensionPoint settings-card
 */
export const kvoxGraphUserSettingsSections: KvoxGraphUserSettingsSections = {
  knowledge: [
    {
      // Issue #369, epic #346. THE ONE CARD WITH A `permission`, and it is the
      // exact string the API enforces rather than an invented gate (Settings UI
      // rule 3): `graph-attribute-defs.controller.ts` gates its writes on
      // `graph:write`, and the page's attribute browser is its core. The
      // preferences on the same page write through `/api/user-settings`
      // (`user_settings:write`, all roles), but a user without `graph:write`
      // has no graph to have preferences about. `graph:write` is seeded to all
      // three roles, so in a stock deployment this hides the card from nobody.
      title: 'Knowledge graph',
      description:
        'How notes become connected knowledge: automatic extraction, how sure a match must be, domains, and your own attributes.',
      Icon: HubOutlinedIcon,
      path: '/settings/knowledge-graph',
      permission: 'graph:write',
    },
  ],
};
