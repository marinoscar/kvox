// =============================================================================
// Transcripts in the Danger Zone (issue #80; declared here by issue #460)
// =============================================================================
//
// The `transcripts` user-data category and the narrow `transcripts` scope: what
// `GET /api/user-data/summary` reports as `transcripts` (count and bytes) and
// the fifth destructive step of `user.data.purge`. They used to be a
// `case 'transcripts'` in `user-data/job-types.ts`, a count plus `transcriptBytes`
// in `UserDataService` and `deleteTranscripts` plus a search-index sweep in
// `UserDataPurgeHandler`; the hooks now live in `transcripts.user-data.hooks.ts`.
// `kvox.manifest.ts` registers the two exports below.
//
// ⚠ THIS FILE MUST STAY LIGHT (see `ask/ask.user-data.ts`): the hook class is
// referenced by `import type` and provided under the string token below.
// =============================================================================

import { userDataCategorySchema } from '../user-data/dto/user-data-summary-parts';
import type { UserDataCategoryDef, UserDataScopeDef } from '../user-data/user-data.registries';
import type { TranscriptsUserDataHooks } from './transcripts.user-data.hooks';

/** The provider token `TranscriptsModule` binds `TranscriptsUserDataHooks` under. */
export const TRANSCRIPTS_USER_DATA_HOOKS = 'TRANSCRIPTS_USER_DATA_HOOKS';

export const TRANSCRIPTS_USER_DATA_CATEGORY: UserDataCategoryDef = {
  id: 'transcripts',
  label: 'Recordings and transcripts',
  description:
    "The caller's transcripts and every storage object they own — source audio, the " +
    'playback rendition, the raw provider result, version snapshots and rendered exports.',
  // ⚠ EVERY NARROW SCOPE MAPS TO EXACTLY ONE CATEGORY. Only the composites
  // fan out (`transcripts` -> this category; `content`/`everything` -> all
  // content categories).
  content: true,
  order: 10,
  summary: {
    key: 'transcripts',
    schema: userDataCategorySchema.describe(
      "The caller's transcripts and every storage object they own — source audio, the " +
        'playback rendition, the raw provider result, version snapshots and rendered exports.',
    ),
    inject: TRANSCRIPTS_USER_DATA_HOOKS,
    run: (hooks: TranscriptsUserDataHooks, userId: string) => hooks.summarize(userId),
  },
  purge: {
    order: 50,
    inject: TRANSCRIPTS_USER_DATA_HOOKS,
    run: (hooks: TranscriptsUserDataHooks, userId: string) => hooks.purge(userId),
  },
};

export const TRANSCRIPTS_USER_DATA_SCOPE: UserDataScopeDef = {
  id: 'transcripts',
  label: 'Recordings',
  description: 'Your recordings and their transcripts only.',
  categories: ['transcripts'],
  confirmation: 'TRANSCRIPTS',
  layer: 'user',
  order: 10,
};
