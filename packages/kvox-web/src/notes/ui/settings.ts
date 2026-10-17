import DescriptionIcon from '@mui/icons-material/Description';

import type { KvoxSettingsCard } from '../../core/ui/index.js';

/**
 * The per-user settings cards of the notes slice, by hub group.
 *
 * @stability experimental
 */
export interface KvoxNotesUserSettingsSections {
  /** The cards of the `Account` group, in order. */
  readonly account: readonly KvoxSettingsCard[];
}

/**
 * The user settings cards of the notes slice, as data: the app spreads
 * `kvoxNotesUserSettingsSections.account` into its `Account` group directly
 * after the `AI Provider` card, where its Note Templates card used to be
 * written out.
 *
 * @stability experimental
 * @extensionPoint settings-card
 */
export const kvoxNotesUserSettingsSections: KvoxNotesUserSettingsSections = {
  account: [
    {
      // Issue #56, epic #45. NO `permission`, like every card here:
      // `note-templates.controller.ts` enforces `note_templates:read` and
      // `note_templates:write`, and BOTH are seeded to all three roles, so a
      // gate here would deny nobody while inventing one the hub's other cards
      // do not have. The page's own real gate is `keyConfigured`, a capability
      // rather than an authorization, so it is checked in the page.
      //
      // Under `Account` alongside `AI Provider`, not `Security`: a template
      // is a preference about how this account's notes are written. It sits
      // directly after the key it depends on — the page renders the
      // "add your key" state without one — so the hub reads in the order the
      // setup actually happens.
      title: 'Note Templates',
      description:
        'Describe the notes you want from a recording, and generate a sample to check the result before you rely on it.',
      Icon: DescriptionIcon,
      path: '/settings/note-templates',
    },
  ],
};
