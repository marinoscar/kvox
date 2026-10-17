import type { Prisma } from '@prisma/client';
import type { UserDataModelHint } from '@marinoscar/platform-api/user-data';

// =============================================================================
// The Ask slice's registrations with the platform's user-data slice (the Danger Zone)
// (issue #80, epic #78; moved next to the slice's configuration by issue #497, epic #491)
// =============================================================================
//
// What the platform's "delete my data" feature needs to know about Ask: one category (`ask`) and a
// hint for `AskConversation`. Ask owns nothing outside the database, so the conversations go INLINE,
// FIRST, with the user's own rows (the messages follow by the `conversation_id` cascade): the hint has
// no delegate, which `test/user-data/user-data-registrations.spec.ts` pins. A running turn finds its
// row gone and stops. `AskUserDataService.deleteAll` is the same deletion for a host without this
// planner.
//
// `user-data.manifest.ts` registers these, in the same relative position the entries had before the
// move; the scopes `content` and `everything` list the category id there.
// =============================================================================

/** The category Ask owns. */
export const ASK_USER_DATA_CATEGORY = {
  id: 'ask',
  label: 'Ask conversations',
  description: 'Your saved Ask conversations and every message in them.',
  content: true,
  order: 6,
} as const;

/**
 * The model hints of the Ask tables.
 *
 * @returns the hint for `AskConversation` (inline delete; `AskMessage` cascades).
 */
export function askUserDataModels(): Array<UserDataModelHint<Prisma.ModelName>> {
  return [{ model: 'AskConversation', category: 'ask' }];
}
