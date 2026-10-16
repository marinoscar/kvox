import {
  BASE_USER_DATA_CATEGORIES,
  BASE_USER_DATA_SCOPES,
  CREDENTIALS_USER_DATA_HOOKS,
  FILES_USER_DATA_HOOKS,
  ONBOARDING_USER_DATA_HOOKS,
} from './user-data.base';
import {
  CredentialsUserDataHooks,
  FilesUserDataHooks,
  OnboardingUserDataHooks,
} from './user-data.base.hooks';
import { USER_DATA_PURGE_MAX_BATCHES } from './user-data.support';

// =============================================================================
// The base categories of the Danger Zone (issue #80, moved from the purge
// handler's spec by issue #460)
// =============================================================================
//
// `files`, `credentials` and `onboarding` stay in the user-data module. Their
// steps used to be private methods of `UserDataPurgeHandler`; the assertions
// below are that handler spec's cases for them, now aimed at the hook classes.
// The scope matrix is `job-types.spec.ts`; the order they run in is
// `handlers/user-data-purge.handler.spec.ts`.
// =============================================================================

const USER_ID = 'user-1';
const ORG_ID = 'org-1';

// -----------------------------------------------------------------------------
// files
// -----------------------------------------------------------------------------

function filesHarness() {
  const prisma = {
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  // The ownership-aware reads live in the object gateway (`KvoxManagedObjects`,
  // #469): `kvoxOwnership: null` is "no module owns it".
  const ownership = {
    summarize: jest.fn().mockResolvedValue({ count: 0, bytes: BigInt(0) }),
    findMany: jest.fn().mockResolvedValue([] as Array<{ id: string }>),
    resolveOrg: jest.fn().mockResolvedValue(ORG_ID),
  };
  const objects = { delete: jest.fn().mockResolvedValue(undefined) };
  const hooks = new FilesUserDataHooks(prisma as never, objects as never, ownership as never);

  return { hooks, prisma, objects, ownership };
}

/** What `findMany({ select: { id: true } })` returns for these ids. */
const rowsOf = (...ids: string[]) => ids.map((id) => ({ id }));

describe('FilesUserDataHooks — summary', () => {
  it('counts only unmanaged objects the caller uploaded — a transcript or note owns the rest', async () => {
    const { hooks, ownership } = filesHarness();

    await hooks.summarize(USER_ID);

    expect(ownership.summarize).toHaveBeenCalledWith({ uploadedById: USER_ID, kvoxOwnership: null });
  });

  it('reports bytes as a decimal STRING, so a large library cannot round silently', async () => {
    const { hooks, ownership } = filesHarness();
    ownership.summarize.mockResolvedValue({
      count: 2,
      bytes: BigInt('9007199254740993'), // > Number.MAX_SAFE_INTEGER
    });

    await expect(hooks.summarize(USER_ID)).resolves.toEqual({
      count: 2,
      bytes: '9007199254740993',
    });
  });
});

describe('FilesUserDataHooks — only unmanaged storage objects are deleted', () => {
  it('selects unmanaged storage objects owned by the caller — never a module-managed one', async () => {
    const { hooks, ownership } = filesHarness();

    await hooks.purge(USER_ID);

    expect(ownership.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uploadedById: USER_ID, kvoxOwnership: null }),
      }),
    );
  });

  it('deletes through ObjectsService.delete, the same path per-item deletes already use', async () => {
    const { hooks, prisma, objects, ownership } = filesHarness();

    ownership.findMany.mockResolvedValueOnce(rowsOf('object-1')).mockResolvedValue([]);

    await hooks.purge(USER_ID);

    expect(objects.delete).toHaveBeenCalledWith('object-1', USER_ID, ORG_ID);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user_data:files_deleted',
          meta: { count: 1, failed: 0 },
        }),
      }),
    );
  });

  it('tolerates a row that has already vanished by the time an unmanaged object delete runs', async () => {
    const { hooks, objects, ownership } = filesHarness();

    ownership.findMany.mockResolvedValueOnce(rowsOf('object-gone')).mockResolvedValue([]);
    objects.delete.mockRejectedValueOnce(new Error('object not found'));

    // The per-row try/catch tolerates this and still completes the job rather
    // than failing the whole run over one already-gone row.
    await expect(hooks.purge(USER_ID)).resolves.toBeUndefined();
  });

  it('excludes a failed object from the next page so the same page is not selected forever', async () => {
    const { hooks, objects, ownership } = filesHarness();

    ownership.findMany.mockResolvedValueOnce(rowsOf('object-stuck')).mockResolvedValue([]);
    objects.delete.mockRejectedValueOnce(new Error('provider refused'));

    await hooks.purge(USER_ID);

    expect(ownership.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: { notIn: ['object-stuck'] } }),
      }),
    );
  });

  it('fails loudly, naming the step, when a selected row never stops matching the query', async () => {
    const { hooks, objects, ownership } = filesHarness();

    // Selected, "deleted" without error, and still there next time.
    ownership.findMany.mockResolvedValue(rowsOf('object-stuck'));
    objects.delete.mockResolvedValue(undefined);

    await expect(hooks.purge(USER_ID)).rejects.toThrow(
      new RegExp(`did not converge after ${USER_DATA_PURGE_MAX_BATCHES} batches`),
    );
  });
});

// -----------------------------------------------------------------------------
// credentials — `everything` only, the one line the composites differ on
// -----------------------------------------------------------------------------

function credentialsHarness() {
  const prisma = {
    personalAccessToken: { count: jest.fn().mockResolvedValue(0) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  // The platform keys (`user_ai_keys`), erased through the platform service.
  const aiKeys = { count: jest.fn().mockResolvedValue(0), removeAll: jest.fn().mockResolvedValue(0) };
  const pat = { revokeAllForUser: jest.fn().mockResolvedValue(0) };
  const hooks = new CredentialsUserDataHooks(prisma as never, aiKeys as never, pat as never);

  return { hooks, prisma, aiKeys, pat };
}

describe('CredentialsUserDataHooks', () => {
  it('counts the AI keys and the access tokens that are not already revoked', async () => {
    const { hooks, prisma, aiKeys } = credentialsHarness();
    aiKeys.count.mockResolvedValue(3);
    prisma.personalAccessToken.count.mockResolvedValue(2);

    await expect(hooks.summarize(USER_ID)).resolves.toEqual({ aiKeys: 3, accessTokens: 2 });

    expect(aiKeys.count).toHaveBeenCalledWith(USER_ID);
    expect(prisma.personalAccessToken.count).toHaveBeenCalledWith({
      where: { userId: USER_ID, revokedAt: null },
    });
  });

  it('erases AI keys and revokes access tokens through the services that own them, and audits the counts', async () => {
    const { hooks, prisma, aiKeys, pat } = credentialsHarness();
    aiKeys.removeAll.mockResolvedValue(2);
    pat.revokeAllForUser.mockResolvedValue(3);

    await hooks.purge(USER_ID);

    expect(aiKeys.removeAll).toHaveBeenCalledWith(USER_ID);
    expect(pat.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER_ID,
        action: 'user_data:credentials_destroyed',
        targetType: 'user',
        targetId: USER_ID,
        meta: { aiKeys: 2, accessTokens: 3 },
      },
    });
  });
});

// -----------------------------------------------------------------------------
// Onboarding state — everything only, and exactly one namespace
// -----------------------------------------------------------------------------
//
// Epic #271 put first-run INTENT in the `onboarding` user-settings namespace:
// `welcomeSeenAt`, `dismissedAt`, `adminDismissedAt`, `skipped[]`. The
// checklist itself is derived live and regresses on its own after a wipe — no
// transcripts and no AI key put its required steps back outstanding — but the
// SURVIVING intent then hides it, because `chooseBannerAudience` bails on
// `dismissedAt` and `FirstRunWelcomeDialog`'s `due` gate bails on
// `welcomeSeenAt`. So `everything` clears it, and nothing else does.
// -----------------------------------------------------------------------------

function onboardingHarness() {
  const prisma = { auditEvent: { create: jest.fn().mockResolvedValue({}) } };
  // The mock is the service, so the assertions below are about the REQUEST the
  // hook makes — which namespace, and only which namespace.
  const userSettings = { patchSettings: jest.fn().mockResolvedValue({}) };
  const hooks = new OnboardingUserDataHooks(prisma as never, userSettings as never);

  return { hooks, prisma, userSettings };
}

describe('OnboardingUserDataHooks', () => {
  it('clears the onboarding namespace', async () => {
    const { hooks, userSettings } = onboardingHarness();

    await hooks.purge(USER_ID);

    expect(userSettings.patchSettings).toHaveBeenCalledTimes(1);
    expect(userSettings.patchSettings).toHaveBeenCalledWith(USER_ID, { onboarding: null });
  });

  // ⚠ THE ASSERTION THAT MATTERS MOST IN THIS SECTION: the patch body is
  // EXACTLY `{ onboarding: null }` and carries no other key. A widening to a
  // whole-settings reset — `{ theme: 'system', navigation: null, ... }`, or a
  // `replaceSettings(userId, DEFAULT_USER_SETTINGS)` — is a one-word change away
  // and would be invisible in every other test, because nothing else here reads
  // settings. It would also be wrong in a way the user pays for: deleting your
  // data is not "reset my preferences", and the account survives, so the person
  // is still signed in looking at a screen that silently changed theme,
  // navigation and notification choices they never touched.
  it('sends EXACTLY { onboarding: null } — never a whole-settings reset', async () => {
    const { hooks, userSettings } = onboardingHarness();

    await hooks.purge(USER_ID);

    const [userId, patch] = userSettings.patchSettings.mock.calls[0];

    expect(userId).toBe(USER_ID);
    expect(patch).toEqual({ onboarding: null });
    expect(Object.keys(patch as Record<string, unknown>)).toEqual(['onboarding']);

    for (const survivor of ['theme', 'profile', 'navigation', 'notifications', 'dataTables']) {
      expect(patch as Record<string, unknown>).not.toHaveProperty(survivor);
    }
  });

  // ⚠ NO `If-Match`. `patchSettings`' third argument is an optimistic
  // concurrency expectation, and a background job queued minutes ago has none
  // to state. Passing one would turn a user who toggled their theme mid-run
  // into a `failed` purge.
  it('passes no expected version — a server-side reset states no concurrency expectation', async () => {
    const { hooks, userSettings } = onboardingHarness();

    await hooks.purge(USER_ID);

    expect(userSettings.patchSettings.mock.calls[0]).toHaveLength(2);
  });

  // Idempotent by construction: clearing an already-absent namespace stores
  // the same absence, so a re-requested deletion after a partial run needs no
  // special case here.
  it('is idempotent — a second run issues the same clear and does not throw', async () => {
    const { hooks, userSettings } = onboardingHarness();

    await hooks.purge(USER_ID);
    await hooks.purge(USER_ID);

    expect(userSettings.patchSettings).toHaveBeenCalledTimes(2);
    expect(userSettings.patchSettings).toHaveBeenNthCalledWith(2, USER_ID, { onboarding: null });
  });

  // ⚠ THROWS RATHER THAN SWALLOWING, unlike the semantic-index cleanup. That
  // one runs BETWEEN destructive steps, where failing would leave the user with
  // a `failed` row and no idea which half ran. This one runs last, after every
  // destructive step has completed and audited, so a failure is unambiguous:
  // everything was deleted, the reset did not happen. Swallowing would cost
  // onboarding state surviving a full wipe with nothing anywhere saying so —
  // the exact bug this step was added to fix.
  it('fails loudly when the settings patch fails — it does not swallow', async () => {
    const { hooks, userSettings } = onboardingHarness();

    userSettings.patchSettings.mockRejectedValue(new Error('settings row is on fire'));

    await expect(hooks.purge(USER_ID)).rejects.toThrow('settings row is on fire');
  });
});

// -----------------------------------------------------------------------------
// The declarations
// -----------------------------------------------------------------------------

describe('base user-data registrations', () => {
  const byId = Object.fromEntries(BASE_USER_DATA_CATEGORIES.map((c) => [c.id, c]));

  it('declares files, credentials and onboarding with today\'s purge positions', () => {
    expect(byId.files.purge?.order).toBe(70);
    expect(byId.credentials.purge?.order).toBe(30);
    expect(byId.onboarding.purge?.order).toBe(80);
  });

  it('keeps credentials and onboarding out of `content` — state about the user, not content they made', () => {
    expect(byId.files.content).toBe(true);
    expect(byId.credentials.content).toBe(false);
    expect(byId.onboarding.content).toBe(false);
  });

  it('gives onboarding no inventory, and files/credentials their summary keys', () => {
    expect(byId.onboarding.summary).toBeUndefined();
    expect(byId.files.summary?.key).toBe('files');
    expect(byId.credentials.summary?.key).toBe('credentials');
  });

  it('points each category at the token its module provides', () => {
    expect(byId.files.purge?.inject).toBe(FILES_USER_DATA_HOOKS);
    expect(byId.credentials.purge?.inject).toBe(CREDENTIALS_USER_DATA_HOOKS);
    expect(byId.onboarding.purge?.inject).toBe(ONBOARDING_USER_DATA_HOOKS);
  });

  it('declares the three scopes no domain owns, each confirmed by its own uppercased id', () => {
    expect(BASE_USER_DATA_SCOPES.map((s) => [s.id, s.confirmation, s.categories])).toEqual([
      ['files', 'FILES', ['files']],
      ['content', 'CONTENT', 'content'],
      ['everything', 'EVERYTHING', 'all'],
    ]);
  });
});
