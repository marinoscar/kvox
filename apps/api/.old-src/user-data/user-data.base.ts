// =============================================================================
// The base categories and scopes of the Danger Zone (issue #80, split by #460)
// =============================================================================
//
// What `user-data/` itself owns, as opposed to what a domain declares beside its
// own module: the plain-uploads category (`files`), the two things that are NOT
// content (`credentials`, `onboarding`), and the three scopes no domain owns —
// `files` (the narrow scope over the base category) and the two composites
// `content` and `everything`, which are resolved from the categories'
// `content` flag exactly as the old `scopeIncludes` switch resolved them.
//
// Registered by `kvox.manifest.ts` (`BASE_USER_DATA_CATEGORIES`,
// `BASE_USER_DATA_SCOPES`); the hook classes (`user-data.base.hooks.ts`) are
// provided by `UserDataModule` under the tokens below. The domain categories
// (`transcripts`, `notes`, `noteTemplates`, `graph`, `ask`) and the two narrow
// domain scopes (`transcripts`, `notes`) are declared in
// `<domain>/<domain>.user-data.ts`.
//
// ⚠ THIS FILE MUST STAY LIGHT (see `ask/ask.user-data.ts`): the hook classes
// are referenced by `import type` and provided under string tokens.
// =============================================================================

import {
  userDataCategorySchema,
  userDataCredentialsSchema,
} from './dto/user-data-summary-parts';
import type {
  CredentialsUserDataHooks,
  FilesUserDataHooks,
  OnboardingUserDataHooks,
} from './user-data.base.hooks';
import type { UserDataCategoryDef, UserDataScopeDef } from './user-data.registries';

/** Provider tokens `UserDataModule` binds the base hook classes under. */
export const FILES_USER_DATA_HOOKS = 'FILES_USER_DATA_HOOKS';
export const CREDENTIALS_USER_DATA_HOOKS = 'CREDENTIALS_USER_DATA_HOOKS';
export const ONBOARDING_USER_DATA_HOOKS = 'ONBOARDING_USER_DATA_HOOKS';

// =============================================================================
// Registrations
// =============================================================================

/** Registered first by `kvox.manifest.ts`; the domain categories follow. */
export const BASE_USER_DATA_CATEGORIES: readonly UserDataCategoryDef[] = [
  {
    id: 'files',
    label: 'Files',
    description:
      'Plain uploads: storage objects the caller uploaded that no module manages. A ' +
      "transcript's audio is NOT counted here — it belongs to the transcript.",
    content: true,
    order: 30,
    summary: {
      key: 'files',
      schema: userDataCategorySchema.describe(
        'Plain uploads: storage objects the caller uploaded that no module manages. A ' +
          "transcript's audio is NOT counted here — it belongs to the transcript.",
      ),
      inject: FILES_USER_DATA_HOOKS,
      run: (hooks: FilesUserDataHooks, userId: string) => hooks.summarize(userId),
    },
    purge: {
      order: 70,
      inject: FILES_USER_DATA_HOOKS,
      run: (hooks: FilesUserDataHooks, userId: string) => hooks.purge(userId),
    },
  },
  // ⚠ CREDENTIALS ARE `everything` ONLY. Revoking a user's API tokens is not
  // implied by "delete my recordings", and a `content` scope that silently
  // signed out their CLI would be a surprise with no way back.
  {
    id: 'credentials',
    label: 'Credentials',
    description:
      "The caller's stored AI provider keys and personal access tokens. Removed by `everything` only.",
    content: false,
    order: 50,
    summary: {
      key: 'credentials',
      schema: userDataCredentialsSchema.describe(
        'What `scope: "everything"` additionally destroys.',
      ),
      inject: CREDENTIALS_USER_DATA_HOOKS,
      run: (hooks: CredentialsUserDataHooks, userId: string) => hooks.summarize(userId),
    },
    purge: {
      order: 30,
      inject: CREDENTIALS_USER_DATA_HOOKS,
      run: (hooks: CredentialsUserDataHooks, userId: string) => hooks.purge(userId),
    },
  },
  // ⚠ ONBOARDING IS `everything` ONLY, for a reason RELATED TO CREDENTIALS
  // RATHER THAN TO THE FOUR CONTENT CATEGORIES: it is not something the
  // user MADE. The `onboarding` user-settings namespace (epic #271, issue
  // #272) holds first-run INTENT — `welcomeSeenAt`, `dismissedAt`,
  // `adminDismissedAt`, `skipped[]` — state this application wrote about the
  // user rather than content the user authored, which is exactly what keeps
  // it out of `content` ("everything you made") on the same line credentials
  // sit on.
  //
  // A full wipe should genuinely start over, and without this it did not.
  // The checklist itself is DERIVED on every read, so after an `everything`
  // run its required steps correctly go outstanding again (no transcripts,
  // no AI key) — but the surviving `dismissedAt` makes
  // `chooseBannerAudience` bail and the surviving `welcomeSeenAt` makes
  // `FirstRunWelcomeDialog`'s `due` gate bail, so the user is never shown the
  // guidance those steps exist to give. A person who deleted everything and
  // then saw no first-run guidance at all would reasonably conclude the
  // feature was broken.
  //
  // ⚠ THIS CATEGORY IS NOT A MEMBER OF THE REQUESTABLE SCOPES, deliberately.
  // Those strings are permanent once a queued payload records one; this
  // category names a STEP a scope fans out to, not a request a caller may
  // make. There is no "delete my onboarding state" scope and there should not
  // be — the replay button on `/settings/getting-started` is already that,
  // without destroying anything.
  {
    id: 'onboarding',
    label: 'Onboarding state',
    description:
      "The caller's first-run guidance intent (welcome seen, banner dismissed, skipped steps). " +
      'Reset by `everything` only; it has no inventory.',
    content: false,
    order: 80,
    purge: {
      order: 80,
      inject: ONBOARDING_USER_DATA_HOOKS,
      run: (hooks: OnboardingUserDataHooks, userId: string) => hooks.purge(userId),
    },
  },
];

/**
 * The scopes no domain owns, registered with the domain's two narrow scopes
 * (`transcripts` 10, `notes` 20) between and around them: `files` 30, `content`
 * 40, `everything` 50 — the narrowest-first order the UI renders.
 */
export const BASE_USER_DATA_SCOPES: readonly UserDataScopeDef[] = [
  {
    id: 'files',
    label: 'Files',
    description: 'Your plain uploads only.',
    categories: ['files'],
    confirmation: 'FILES',
    layer: 'user',
    order: 30,
  },
  {
    id: 'content',
    label: 'All content',
    description:
      'Everything you made: recordings, notes, uploaded files, your own note templates, your ' +
      'knowledge graph and your Ask conversations.',
    categories: 'content',
    confirmation: 'CONTENT',
    layer: 'user',
    order: 40,
  },
  {
    id: 'everything',
    label: 'Everything',
    description:
      'All content plus your AI provider keys and personal access tokens, and a reset of your ' +
      'first-run guidance.',
    categories: 'all',
    confirmation: 'EVERYTHING',
    layer: 'user',
    order: 50,
  },
];
