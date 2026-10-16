import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks, setupMockUserSettings } from '../fixtures/mock-setup.helper';
import {
  createMockAdminUser,
  createMockContributorUser,
  createMockViewerUser,
  authHeader,
} from '../helpers/auth-mock.helper';
import { invalidateAiResolverCache, primeAiReadiness } from '../helpers/ai-readiness.fixtures';

// =============================================================================
// GET /api/onboarding and GET /api/admin/onboarding/metrics (issue #481, epic #478)
// =============================================================================
//
// Onboarding is the platform's slice. One route, `GET /api/onboarding`, carries the caller's
// stored UI state, the `user` checklist and, for a holder of `system_settings:read`, the
// `admin` checklist; `GET /api/admin/onboarding/metrics` is the admin-only aggregate. This
// suite drives them through the real guard stack and the real registries, with a mocked
// database, and pins what the retired kvox suite pinned (issues #274/#275), restated in the
// platform's wire shape:
//
//   1. THE USER ROUTE NEEDS ONLY `user_settings:read`, WHICH EVERY ROLE HOLDS. The route is
//      `@Auth({ permissions })`, so the guard stack attaches the resolved permission list; a
//      Viewer (this application's default role) gets 200 and only the steps they can act on.
//      A caller with NO permissions at all is refused with 403, and the suite asserts that
//      too, so the day a role is seeded without `user_settings:read` this fails loudly
//      instead of hiding the checklist from the people it exists for.
//   2. THE ADMIN BLOCK IS NON-NULL ONLY FOR `system_settings:read`, and a Viewer's request
//      never runs a Doctor check or counts the allowlist (asserted on the stubs, not the
//      body: a body assertion passes on an implementation that read everything and dropped it).
//   3. THE STATES A CLIENT MEETS ON A FRESH DEPLOYMENT, with the retired statuses and
//      reasons.
// =============================================================================

describe('Onboarding Integration', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();

    // A deployment where nobody has created anything and nobody has been invited. The `mockDeep`
    // default for an unconfigured `count` is `undefined`, which would compare falsely against
    // `> 0` by accident rather than on purpose.
    context.prismaMock.transcript.count.mockResolvedValue(0);
    context.prismaMock.note.count.mockResolvedValue(0);
    context.prismaMock.allowedEmail.count.mockResolvedValue(1);
    context.prismaMock.pushSubscription.count.mockResolvedValue(0);
    // ⚠ EXPLICITLY `null`, not left to `mockDeep`: `KvoxAi.readiness` reads whether the caller has a
    // key as `row !== null`, and an unconfigured deep mock answers `undefined`, which is `!== null`.
    context.prismaMock.userAiKey.findUnique.mockResolvedValue(null);
    context.prismaMock.aiModel.findMany.mockResolvedValue([]);
    // The resolver reuses what it read for five seconds per process.
    invalidateAiResolverCache(context);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** A signed-in, active user holding NO roles and therefore NO permissions. */
  async function createNoPermissionUser(): Promise<{ id: string; accessToken: string }> {
    const jwtService = context.module.get<JwtService>(JwtService);
    const id = 'zero-permission-user';
    const email = 'zero-permission-user@example.com';

    context.prismaMock.user.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id !== id && where?.email !== email) return null;
      return {
        id,
        email,
        displayName: null,
        providerDisplayName: 'No Permissions',
        profileImageUrl: null,
        providerProfileImageUrl: null,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        userRoles: [],
      };
    });

    const accessToken = jwtService.sign({ sub: id, email, roles: [] });
    return { id, accessToken };
  }

  const get = (token: string, path = '/api/onboarding') =>
    request(context.app.getHttpServer()).get(path).set(authHeader(token));

  function stepOf(steps: Array<{ id: string }>, id: string): any {
    return steps.find((step) => step.id === id);
  }

  const idsOf = (steps: Array<{ id: string }>) => steps.map((step) => step.id);

  // ---------------------------------------------------------------------------
  // GET /api/onboarding, the user block
  // ---------------------------------------------------------------------------

  describe('GET /api/onboarding (user block)', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer()).get('/api/onboarding').expect(401);
    });

    it('returns 403 for a caller who holds no permission at all', async () => {
      // CLAIM 1, the negative half. The route's one permission is `user_settings:read`.
      const nobody = await createNoPermissionUser();

      await get(nobody.accessToken).expect(403);
    });

    it('returns 200 for a Viewer, with no admin block', async () => {
      // CLAIM 1, the positive half: every seeded role holds `user_settings:read`.
      const viewer = await createMockViewerUser(context);
      const response = await get(viewer.accessToken).expect(200);

      expect(response.body.data.admin).toBeNull();
      expect(Array.isArray(response.body.data.user.steps)).toBe(true);
    });

    it('lists the three activation steps and the platform user steps for a fresh Viewer', async () => {
      // The OpenAI slot is on, which is what makes a key savable (and the step relevant).
      primeAiReadiness({ hasKey: false });
      const viewer = await createMockViewerUser(context);

      const response = await get(viewer.accessToken).expect(200);
      const steps = response.body.data.user.steps;

      expect(idsOf(steps)).toEqual([
        'user.ai_key',
        'user.first_transcript',
        'user.first_note',
        'user.profile',
        'user.notifications',
      ]);
      expect(stepOf(steps, 'user.ai_key')).toMatchObject({ status: 'todo', blockedReason: null, tier: 'required' });
      expect(stepOf(steps, 'user.first_transcript')).toMatchObject({ status: 'blocked', tier: 'required' });
      expect(stepOf(steps, 'user.first_transcript').blockedReason).toContain('administrator');
      expect(stepOf(steps, 'user.first_note')).toMatchObject({ status: 'blocked', skippable: true });
      expect(stepOf(steps, 'user.first_note').blockedReason).toContain('AI provider key');
    });

    it('omits `user.ai_key` entirely on a fresh deployment, where no AI provider is switched on', async () => {
      // ABSENT, not pending: the platform refuses to store a key for a provider whose slot is off
      // (`AI_PROVIDER_DISABLED`), so there is no vendor a key could belong to.
      const viewer = await createMockViewerUser(context);

      const response = await get(viewer.accessToken).expect(200);

      expect(stepOf(response.body.data.user.steps, 'user.ai_key')).toBeUndefined();
      expect(stepOf(response.body.data.user.steps, 'user.first_note').blockedReason).toContain('administrator');
    });

    it('returns a skipped step, marked, and keeps `skipped` as stored', async () => {
      const contributor = await createMockContributorUser(context);
      setupMockUserSettings(contributor.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
        onboarding: { welcomeSeenAt: '2026-01-01T00:00:00.000Z', skipped: ['user.first_note'] },
      });

      const response = await get(contributor.accessToken).expect(200);
      const { settings, user } = response.body.data;

      // STILL RETURNED: filtering server-side would make the skip irreversible through the UI.
      expect(stepOf(user.steps, 'user.first_note')).toMatchObject({ skipped: true, skippable: true });
      expect(settings).toMatchObject({
        welcomeSeenAt: '2026-01-01T00:00:00.000Z',
        checklistDismissedAt: null,
        adminDismissedAt: null,
        skipped: ['user.first_note'],
      });
    });

    it('counts a Viewer\'s transcripts and notes once each, however many steps name them', async () => {
      // Facts are resolved only for the steps that survive the permission and applies gates.
      const viewer = await createMockViewerUser(context);

      await get(viewer.accessToken).expect(200);

      // Resolved once each for the steps that are present, never per step.
      expect(context.prismaMock.transcript.count).toHaveBeenCalledTimes(1);
      expect(context.prismaMock.note.count).toHaveBeenCalledTimes(1);
    });

    it('never publishes the permission a step guards', async () => {
      const admin = await createMockAdminUser(context);

      const response = await get(admin.accessToken).expect(200);

      for (const step of [...response.body.data.user.steps, ...response.body.data.admin.steps]) {
        expect(step).not.toHaveProperty('permission');
        expect(step).not.toHaveProperty('facts');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/onboarding, the admin block
  // ---------------------------------------------------------------------------

  describe('GET /api/onboarding (admin block)', () => {
    it('is present for an administrator and lists exactly one `admin.ai`', async () => {
      const admin = await createMockAdminUser(context);

      const response = await get(admin.accessToken).expect(200);
      const steps = response.body.data.admin.steps;

      expect(steps.filter((step: { id: string }) => step.id === 'admin.ai')).toHaveLength(1);
      expect(idsOf(steps)).toEqual(
        expect.arrayContaining(['admin.transcription', 'admin.smoke_test', 'admin.ai', 'admin.access']),
      );
    });

    it('reports `admin.transcription` and `admin.ai` as todo on a fresh deployment', async () => {
      const admin = await createMockAdminUser(context);

      const response = await get(admin.accessToken).expect(200);
      const { admin: block } = response.body.data;

      expect(stepOf(block.steps, 'admin.transcription').status).toBe('todo');
      expect(stepOf(block.steps, 'admin.ai').status).toBe('todo');
      expect(block.requiredDone).toBe(false);
    });

    it('blocks the smoke test behind the provider it depends on, and still offers the skip control', async () => {
      const admin = await createMockAdminUser(context);

      const response = await get(admin.accessToken).expect(200);
      const step = stepOf(response.body.data.admin.steps, 'admin.smoke_test');

      // Since #299 this step is `recommended` and skippable, which is what makes the reason
      // load-bearing: skipping something that was merely blocked is a decision made on bad
      // information. So all three are asserted together.
      expect(step.status).toBe('blocked');
      expect(step.blockedReason).toContain('transcription provider');
      expect(step.skippable).toBe(true);
    });

    it('keeps a skipped `admin.smoke_test` skipped', async () => {
      const admin = await createMockAdminUser(context);
      setupMockUserSettings(admin.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
        onboarding: { skipped: ['admin.smoke_test'] },
      });

      const response = await get(admin.accessToken).expect(200);

      expect(stepOf(response.body.data.admin.steps, 'admin.smoke_test').skipped).toBe(true);
    });

    it('reports `admin.access` todo while only the bootstrap administrator is allowlisted, and done after an invite', async () => {
      const admin = await createMockAdminUser(context);

      context.prismaMock.allowedEmail.count.mockResolvedValue(0);
      const fresh = await get(admin.accessToken).expect(200);
      expect(stepOf(fresh.body.data.admin.steps, 'admin.access').status).toBe('todo');

      // The count excludes `INITIAL_ADMIN_EMAIL`; derived on every read, nothing stored.
      context.prismaMock.allowedEmail.count.mockResolvedValue(3);
      const invited = await get(admin.accessToken).expect(200);
      expect(stepOf(invited.body.data.admin.steps, 'admin.access').status).toBe('done');
    });

    it('derives status on every read: nothing is stored and nothing is written', async () => {
      const admin = await createMockAdminUser(context);

      await get(admin.accessToken).expect(200);

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
      expect(context.prismaMock.userSettings.create).not.toHaveBeenCalled();
      expect(context.prismaMock.userSettings.upsert).not.toHaveBeenCalled();
      expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
    });

    it('a Viewer\'s request counts no allowlist entry (an admin fact is never resolved for them)', async () => {
      const viewer = await createMockViewerUser(context);

      await get(viewer.accessToken).expect(200);

      expect(context.prismaMock.allowedEmail.count).not.toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/onboarding/metrics
  // ---------------------------------------------------------------------------

  describe('GET /api/admin/onboarding/metrics', () => {
    it('returns 401 without auth and 403 for a Viewer', async () => {
      await request(context.app.getHttpServer()).get('/api/admin/onboarding/metrics').expect(401);

      const viewer = await createMockViewerUser(context);
      await get(viewer.accessToken, '/api/admin/onboarding/metrics').expect(403);
    });

    it('runs the one aggregate statement for an administrator and returns counts only', async () => {
      const admin = await createMockAdminUser(context);
      (context.prismaMock as any).$transaction.mockImplementation(async (work: (tx: unknown) => unknown) =>
        work({
          $executeRawUnsafe: jest.fn().mockResolvedValue(0),
          $queryRawUnsafe: jest.fn().mockResolvedValue([
            { cohort_size: 4, f0_completed: 2, f1_completed: 1, f2_completed: 0, f3_completed: 0, f4_completed: 0 },
          ]),
        }),
      );

      const response = await get(admin.accessToken, '/api/admin/onboarding/metrics?days=14').expect(200);

      expect(response.body.data).toMatchObject({ windowDays: 14, cohortSize: 4 });
      expect(JSON.stringify(response.body.data)).not.toMatch(/@|user-id/);
    });
  });
});
