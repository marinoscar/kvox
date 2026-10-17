import ManageSearchIcon from '@mui/icons-material/ManageSearch';

import type { KvoxSettingsCard } from '../../core/ui/index.js';

/**
 * The per-user settings cards of the search slice, by hub group.
 *
 * @stability experimental
 */
export interface KvoxSearchUserSettingsSections {
  /** The cards of the `Account` group, in order. */
  readonly account: readonly KvoxSettingsCard[];
}

/**
 * The user settings cards of the search slice, as data: the app spreads
 * `kvoxSearchUserSettingsSections.account` into its `Account` group directly
 * after the `AI Provider` card, where its Search Indexing card used to be
 * written out.
 *
 * @stability experimental
 * @extensionPoint settings-card
 */
export const kvoxSearchUserSettingsSections: KvoxSearchUserSettingsSections = {
  account: [
    {
      // Issue #191, epic #165. NO `permission`, like every card here, and
      // here the API's own shape is the argument rather than a convention
      // this file follows: `search-index.controller.ts` gates
      // `GET /api/search/index-status` and `POST /api/search/index` on
      // `@Auth()` with NO permission string, because the resource is the
      // caller's OWN content and the caller's OWN vendor account, scoped by
      // `ownerId` in the query itself, the identical posture
      // `ai-credentials.controller.ts` and `/api/user-data` take. Gating on
      // `transcripts:read` + `notes:read` was the near miss: `PermissionsGuard`
      // requires ALL declared permissions, so a user narrowed to one document
      // type would be hidden from the page reporting the state of the other.
      //
      // A card's `permission` must equal what the controller enforces, so do
      // not add one here.
      //
      // Under `Account`, directly after `AI Provider`, because that is the
      // order the setup actually happens in: indexing spends the key that
      // page collects, and this page's primary action is disabled with a link
      // back to it until one is saved. A PER-USER card and never an admin one:
      // the key is the user's, the content is the user's, and the bill is
      // the user's, so there is nobody else who could press this button.
      title: 'Search Indexing',
      description:
        'See what of your library can be found by meaning rather than keyword, and index the rest. Runs on your own AI provider account.',
      Icon: ManageSearchIcon,
      path: '/settings/search-index',
    },
  ],
};
