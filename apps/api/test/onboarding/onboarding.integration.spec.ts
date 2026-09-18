import request from 'supertest';
import { JwtService } from '@nestjs/jwt';

import { TestContext, createTestApp, closeTestApp } from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks, setupMockUserSettings } from '../fixtures/mock-setup.helper';
import { createMockAdminUser, authHeader } from '../helpers/auth-mock.helper';
import { DEFAULT_SYSTEM_SETTINGS } from '../../src/common/types/settings.types';
import { EmailSettingsService } from '../../src/email/email-settings.service';
import { PushConfigService } from '../../src/notifications/push-config.service';

// =============================================================================
// GET /api/onboarding and GET /api/admin/onboarding (issue #275, epic #271)
// =============================================================================
//
// Two routes, two gates, two prefixes — the same split `/api/nodes` and
// `/api/admin/nodes` already make. What this suite exists to prove is that the
// split is doing the work the design claims, and there are three separate
// claims:
//
//   1. THE USER ROUTE CARRIES NO PERMISSION STRING. A caller holding literally
//      zero permissions — which is what a freshly invited account with no role
//      looks like — must get 200. The fixture below is the same
//      `createNoPermissionUser` shape `test/settings/notification-events
//      .integration.spec.ts` established for exactly this argument.
//
//   2. THE ADMIN ROUTE IS 403 FOR THAT SAME CALLER, and the 403 comes from the
//      route's own gate rather than from anything the handler decides.
//
//   3. ⚠ A VIEWER'S REQUEST DOES NOT MERELY OMIT ADMIN FACTS FROM ITS BODY — IT
//      NEVER READS THEM. That is asserted with spies on `EmailSettingsService`,
//      `PushConfigService` and the `users`/`allowed_emails` counts, deliberately
//      NOT by inspecting the response: a body assertion passes just as happily
//      on an implementation that reads every admin fact and then drops it,
//      which is precisely the implementation #275 rejected.
//
// The rest is the wire-level half of #274's truth table: the states a client
// will actually meet on a fresh deployment, which is the state every one of
// these deployments starts in.
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

    // A deployment where nobody has created anything and nobody has been
    // invited: one account (the initial admin), one allowlist entry. The
    // `mockDeep` default for an unconfigured `count` is `undefined`, which
    // would compare falsely against `> 0` by accident rather than on purpose.
    context.prismaMock.transcript.count.mockResolvedValue(0);
    context.prismaMock.note.count.mockResolvedValue(0);
    context.prismaMock.user.count.mockResolvedValue(1);
    context.prismaMock.allowedEmail.count.mockResolvedValue(1);
    // ⚠ EXPLICITLY `null`, not left to `mockDeep`. `UserAiCredentialsService
    // .hasKey` returns `row !== null`, and an unconfigured deep mock answers
    // `undefined` — which is `!== null`, so every caller would appear to have
    // stored an AI key and `user.ai_key` would report `satisfied` on a
    // deployment where nobody has one.
    context.prismaMock.userAiCredential.findUnique.mockResolvedValue(null);
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
        // No roles at all — `toRequestUser` derives an empty permission set
        // from an empty `userRoles` array.
        userRoles: [],
      };
    });

    const accessToken = jwtService.sign({ sub: id, email, roles: [] });
    return { id, accessToken };
  }

  /**
   * Point the `system_settings` mock at a specific stored value.
   *
   * ⚠ The base mock answers the SAME row for every `key`, so this replaces the
   * whole settings blob rather than one namespace — which is why the caller
   * spreads `DEFAULT_SYSTEM_SETTINGS` rather than passing a fragment. A
   * fragment would fail each namespace's own `safeParse` and silently fall back
   * to those same defaults, producing a test that passes without testing
   * anything.
   */
  function withSystemSettings(value: unknown): void {
    context.prismaMock.systemSettings.findUnique.mockResolvedValue({
      id: 'settings-global',
      key: 'global',
      value,
      version: 1,
      updatedByUserId: null,
      updatedByUser: null,
      updatedAt: new Date(),
    });
  }

  function stepOf(body: any, key: string): any {
    return body.data.steps.find((step: { key: string }) => step.key === key);
  }

  // ---------------------------------------------------------------------------
  // GET /api/onboarding — the user checklist
  // ---------------------------------------------------------------------------

  describe('GET /api/onboarding', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer()).get('/api/onboarding').expect(401);
    });

    it('a user with an empty permission set gets 200 and `audience: "user"`', async () => {
      // CLAIM 1. This is the whole reason the route carries no permission
      // string: a Viewer is this application's default role, and a freshly
      // invited account may hold nothing at all — so the users the checklist
      // exists for would be precisely the users who could not read it.
      const user = await createNoPermissionUser();

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data.audience).toBe('user');
      expect(Array.isArray(response.body.data.steps)).toBe(true);
    });

    it('an admin reads their own user checklist from the same route', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // An administrator is also a user, and the two checklists are separate
      // surfaces — #272 keeps `dismissedAt` and `adminDismissedAt` apart for
      // the same reason.
      expect(response.body.data.audience).toBe('user');
    });

    it('never reads an admin-only fact on behalf of a caller who holds no permissions', async () => {
      // CLAIM 3, and the assertion this suite is really for. Spies, not the
      // body: an implementation that read every admin fact and then filtered it
      // out of the response would satisfy any body assertion written here, and
      // it is exactly the implementation #275 rejected.
      const emailSettings = context.module.get(EmailSettingsService, {
        strict: false,
      });
      const pushConfig = context.module.get(PushConfigService, { strict: false });
      const emailSpy = jest.spyOn(emailSettings, 'describeForAdmin');
      const pushSpy = jest.spyOn(pushConfig, 'describeForAdmin');

      const user = await createNoPermissionUser();

      await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(emailSpy).not.toHaveBeenCalled();
      expect(pushSpy).not.toHaveBeenCalled();
      expect(context.prismaMock.user.count).not.toHaveBeenCalled();
      expect(context.prismaMock.allowedEmail.count).not.toHaveBeenCalled();
    });

    it('offers every step whose permission the caller DOES hold', async () => {
      // ⚠ THE REGRESSION THIS PINS IS SILENT. `RolesGuard` and
      // `PermissionsGuard` attach the resolved permission list to the request,
      // and both return early on a route declaring neither — which is this one.
      // Reading `permissions` straight off `@CurrentUser()` here therefore
      // yields `undefined`, an empty set, and a 200 whose checklist is missing
      // three of its four steps with no error anywhere. See `OnboardingCaller`.
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.steps.map((step: { key: string }) => step.key)).toEqual([
        'user.ai_key',
        'user.first_transcript',
        'user.first_note',
        'user.profile',
      ]);
    });

    it('a step whose destination permission the caller lacks is absent, not disabled', async () => {
      // A zero-permission account holds neither `transcripts:write` nor
      // `notes:write`, so neither step is offered — going to either destination
      // would end in a 403 the checklist had promised would work.
      const user = await createNoPermissionUser();

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(stepOf(response.body, 'user.first_transcript')).toBeUndefined();
      expect(stepOf(response.body, 'user.first_note')).toBeUndefined();
    });

    it('omits `user.ai_key` entirely when this deployment names no AI vendor', async () => {
      // ABSENT, not pending: with `ai.provider` null there is no vendor a key
      // could belong to, so the step would lead to a form that cannot be filled
      // in. (#83's argument runs the other way for a NAMED provider with AI
      // switched off, which is the ordinary fresh-deployment state below.)
      withSystemSettings({
        ...DEFAULT_SYSTEM_SETTINGS,
        ai: { ...DEFAULT_SYSTEM_SETTINGS.ai, provider: null },
      });

      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stepOf(response.body, 'user.ai_key')).toBeUndefined();
    });

    it('offers `user.ai_key` on a fresh deployment, where a vendor is named but AI is off', async () => {
      // The #83 state, which every deployment of this application starts in:
      // `DEFAULT_SYSTEM_SETTINGS.ai` ships `enabled: false` with
      // `provider: 'openai'`, precisely so the first administrator can save the
      // key they need in order to load the model list that turns AI on.
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const step = stepOf(response.body, 'user.ai_key');

      expect(step.status).toBe('pending');
      expect(step.blockedReason).toBeNull();
    });

    it('blocks `user.first_transcript` with a reason naming the administrator', async () => {
      // Transcription is unconfigured on a fresh deployment, so this is the
      // first thing a new user meets. `blocked` rather than `pending` is what
      // tells them the disabled upload button is not their to-do.
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const step = stepOf(response.body, 'user.first_transcript');

      expect(step.status).toBe('blocked');
      expect(step.blockedReason).toContain('administrator');
      expect(step.blockedReason).not.toBeNull();
    });

    it('returns a skipped step, marked, and counts it out of the totals', async () => {
      const admin = await createMockAdminUser(context);
      setupMockUserSettings(admin.id, {
        theme: 'system',
        profile: { imageSource: 'provider', imageObjectId: null },
        onboarding: { skipped: ['user.profile'] },
      });

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const skipped = stepOf(response.body, 'user.profile');
      const outstanding = response.body.data.steps.filter(
        (step: { status: string; skipped: boolean }) =>
          step.status !== 'satisfied' && !step.skipped,
      );

      // ⚠ STILL RETURNED. Filtering server-side would make the skip
      // irreversible through the UI — the getting-started page has to be able
      // to show it and offer to un-skip it.
      expect(skipped).toBeDefined();
      expect(skipped.skipped).toBe(true);
      expect(skipped.skippable).toBe(true);
      expect(response.body.data.totalRemaining).toBe(outstanding.length);
      expect(
        response.body.data.steps.some(
          (step: { key: string; skipped: boolean }) =>
            step.key !== 'user.profile' && step.skipped,
        ),
      ).toBe(false);
    });

    it('counts only unsatisfied `required` steps into requiredRemaining', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const { steps, requiredRemaining, totalRemaining, allRequiredSatisfied } =
        response.body.data;
      const outstanding = steps.filter(
        (step: { status: string; skipped: boolean }) =>
          step.status !== 'satisfied' && !step.skipped,
      );

      expect(requiredRemaining).toBe(
        outstanding.filter((step: { tier: string }) => step.tier === 'required').length,
      );
      expect(totalRemaining).toBe(outstanding.length);
      expect(allRequiredSatisfied).toBe(requiredRemaining === 0);
      // A fresh deployment has real required work outstanding, so this is not
      // a vacuous comparison of two zeroes.
      expect(requiredRemaining).toBeGreaterThan(0);
    });

    it('never publishes the permission a step guards', () => {
      // The map of which permission guards which page is not something every
      // account needs. Asserted on the DTO's own keys rather than on a
      // hand-written list, so a field added to the response shape is caught.
      const admin = createMockAdminUser(context);

      return admin.then(async (user) => {
        const response = await request(context.app.getHttpServer())
          .get('/api/onboarding')
          .set(authHeader(user.accessToken))
          .expect(200);

        for (const step of response.body.data.steps) {
          expect(step).not.toHaveProperty('permission');
          expect(step).not.toHaveProperty('audience');
        }
      });
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/admin/onboarding — the deployment checklist
  // ---------------------------------------------------------------------------

  describe('GET /api/admin/onboarding', () => {
    it('returns 401 without auth', async () => {
      await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .expect(401);
    });

    it('returns 403 for the zero-permission user who gets 200 on the user route', async () => {
      // CLAIM 2. The two routes differ by their gate and their prefix, not by a
      // decision the handler makes — so the same caller meets a hard 403 here
      // without any admin fact having been read to produce it.
      const user = await createNoPermissionUser();

      await request(context.app.getHttpServer())
        .get('/api/onboarding')
        .set(authHeader(user.accessToken))
        .expect(200);

      await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(user.accessToken))
        .expect(403);
    });

    it('returns 200 with `audience: "admin"` for an administrator', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data.audience).toBe('admin');
    });

    it('reports `admin.transcription` and `admin.ai` as pending on a fresh deployment', async () => {
      // The state every deployment of this application starts in: no
      // transcription provider, AI switched off with an empty allow-list.
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stepOf(response.body, 'admin.transcription').status).toBe('pending');
      expect(stepOf(response.body, 'admin.ai').status).toBe('pending');
      expect(response.body.data.allRequiredSatisfied).toBe(false);
    });

    it('blocks the smoke test behind the provider it depends on', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      const step = stepOf(response.body, 'admin.smoke_test');

      // A step nobody can yet perform must say why, rather than sitting in the
      // list looking like a to-do the administrator is ignoring — and since
      // #299 this one is `recommended` and carries a skip control, which is
      // what makes the reason load-bearing rather than decorative: skipping
      // something that was merely blocked is a decision made on bad
      // information. So both halves are asserted together over the wire — the
      // step is blocked, it says by what, AND the control is offered anyway.
      expect(step.status).toBe('blocked');
      expect(step.blockedReason).toContain('transcription provider');
      expect(step.skippable).toBe(true);
    });

    it('does read the admin facts on this route — the mirror of the Viewer assertion', async () => {
      // Without this, the spy assertion on the user route would be satisfied by
      // an implementation that never read those facts at all.
      const emailSettings = context.module.get(EmailSettingsService, {
        strict: false,
      });
      const pushConfig = context.module.get(PushConfigService, { strict: false });
      const emailSpy = jest.spyOn(emailSettings, 'describeForAdmin');
      const pushSpy = jest.spyOn(pushConfig, 'describeForAdmin');

      const admin = await createMockAdminUser(context);

      await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(emailSpy).toHaveBeenCalledTimes(1);
      expect(pushSpy).toHaveBeenCalledTimes(1);
      expect(context.prismaMock.user.count).toHaveBeenCalledTimes(1);
      expect(context.prismaMock.allowedEmail.count).toHaveBeenCalledTimes(1);
    });

    it('reports `admin.access` pending while only the seeded administrator exists', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      // One account, one allowlist entry — the day-zero state, which `> 0`
      // would have called satisfied.
      expect(stepOf(response.body, 'admin.access').status).toBe('pending');
    });

    it('reports `admin.access` satisfied once somebody else has been invited', async () => {
      context.prismaMock.allowedEmail.count.mockResolvedValue(2);

      const admin = await createMockAdminUser(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stepOf(response.body, 'admin.access').status).toBe('satisfied');
    });

    it('derives status on every read — nothing is stored and nothing is written', async () => {
      // The endpoint that reports "this is set up" must not itself be what
      // records it. Two consecutive reads against changed state must disagree,
      // and neither may write.
      const admin = await createMockAdminUser(context);

      context.prismaMock.allowedEmail.count.mockResolvedValue(5);
      const configured = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);
      expect(stepOf(configured.body, 'admin.access').status).toBe('satisfied');

      context.prismaMock.allowedEmail.count.mockResolvedValue(1);
      const reverted = await request(context.app.getHttpServer())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);
      expect(stepOf(reverted.body, 'admin.access').status).toBe('pending');

      expect(context.prismaMock.systemSettings.update).not.toHaveBeenCalled();
      expect(context.prismaMock.systemSettings.upsert).not.toHaveBeenCalled();
      expect(context.prismaMock.auditEvent.create).not.toHaveBeenCalled();
    });
  });
});
