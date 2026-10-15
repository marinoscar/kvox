// =============================================================================
// Ask conversations in the Danger Zone (issue #376, epic #348; declared here by
// issue #460)
// =============================================================================
//
// The `ask` user-data category: what `GET /api/user-data/summary` reports as
// `askConversations` and what `user.data.purge` deletes first. It used to be a
// `case 'ask'` in `user-data/job-types.ts`, a count in `UserDataService` and a
// private method of `UserDataPurgeHandler`; those three now live in
// `ask.user-data.hooks.ts`, and `kvox.manifest.ts` registers
// `ASK_USER_DATA_CATEGORY` with the user-data category registry.
//
// ⚠ THIS FILE MUST STAY LIGHT. The manifest imports it before the settings
// namespaces are registered, so it may not import (at runtime) anything that
// composes a schema from the settings registries — which is most of the
// application. The hook CLASS (heavy: it injects services) therefore lives in
// `ask.user-data.hooks.ts`, is provided by `AskModule` under the string token
// below, and is referenced here by `import type` only.
// =============================================================================

import { userDataCountOnlySchema } from '../user-data/dto/user-data-summary-parts';
import type { UserDataCategoryDef } from '../user-data/user-data.registries';
import type { AskUserDataHooks } from './ask.user-data.hooks';

/** The provider token `AskModule` binds `AskUserDataHooks` under. */
export const ASK_USER_DATA_HOOKS = 'ASK_USER_DATA_HOOKS';

export const ASK_USER_DATA_CATEGORY: UserDataCategoryDef = {
  id: 'ask',
  label: 'Ask conversations',
  description:
    "The caller's saved Ask conversations (and every message in them). Removed by `content` " +
    'and `everything` only — no narrow scope touches them.',
  // ⚠ ASK CONVERSATIONS ARE `content`/`everything` ONLY (#376, epic #348).
  //
  // A saved conversation is content the user MADE — their own questions and
  // the answers they asked for — so it follows `content`, the line note
  // templates and the graph sit on. No narrow scope takes it: "Delete notes"
  // does not silently empty a different page the user did not open.
  //
  // A CATEGORY, NOT A SCOPE, like `graph`: the requestable scopes are
  // unchanged. Deleted INLINE by the handler (one indexed DELETE; messages
  // cascade) rather than through a job of its own. A deleted ACCOUNT loses its
  // conversations separately, by the `ask_conversations.owner_id` Cascade.
  content: true,
  order: 70,
  summary: {
    key: 'askConversations',
    schema: userDataCountOnlySchema.describe(
      "The caller's saved Ask conversations (and every message in them). Removed by `content` " +
        'and `everything` only — no narrow scope touches them.',
    ),
    inject: ASK_USER_DATA_HOOKS,
    run: (hooks: AskUserDataHooks, userId: string) => hooks.summarize(userId),
  },
  purge: {
    order: 10,
    inject: ASK_USER_DATA_HOOKS,
    run: (hooks: AskUserDataHooks, userId: string) => hooks.purge(userId),
  },
};
