import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import { authHeader } from '../helpers/auth-mock.helper';
import { createMockUserSettings } from '../fixtures/test-data.factory';
import {
  KVOX_DOMAIN_PERMISSIONS,
  createMembershipAdmin,
  createMembershipContributor,
  createMembershipUser,
  createMembershipViewer,
} from '../helpers/membership-user.helper';

// =============================================================================
// ⚠ ROLES ARE BUILT THE WAY PRODUCTION STORES THEM (issue #465, epic #462)
// =============================================================================
//
// Platform migration 0024 moved `contributor` and `viewer` from `user_roles`
// onto `memberships.role_id`; `admin` is the only system role. Every user here
// comes from `test/helpers/membership-user.helper.ts`, which builds that shape
// from the SAME catalog the seed writes (`prisma/catalog/permissions.json`):
//
//   Viewer / Contributor   no `user_roles`, an ACTIVE default-org membership
//   Admin                  `admin` system role + an `org_admin` membership
//
// so a Viewer holds `transcripts:*`, `notes:*`, `note_templates:*` and
// `graph:*` THROUGH THE MEMBERSHIP, and the assertions below fail if that path
// stops working (the failure mode the issue names: a guard that reads only
// `user_roles` leaves every non-admin without domain permissions).
// =============================================================================

describe('RBAC System (Integration)', () => {
  let context: TestContext;

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
  });

  afterAll(async () => {
    await closeTestApp(context);
  });

  beforeEach(async () => {
    resetPrismaMock();
    setupBaseMocks();
  });

  describe('Role-Based Access', () => {
    describe('Admin Role', () => {
      it('should have access to user management', async () => {
        const admin = await createMembershipAdmin(context);

        // Mock user list response
        context.prismaMock.user.findMany.mockResolvedValue([]);
        context.prismaMock.user.count.mockResolvedValue(0);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(admin.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
        expect(Array.isArray(response.body.data.items)).toBe(true);
      });

      it('should have access to system settings', async () => {
        const admin = await createMembershipAdmin(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should be able to modify system settings', async () => {
        const admin = await createMembershipAdmin(context);

        const updatedSettings = {
          id: 'settings-id',
          key: 'default',
          value: {
            notifications: { browserEnabled: false, disabledEvents: [] },
          },
          version: 2,
          updatedAt: new Date(),
        };

        context.prismaMock.systemSettings.update.mockResolvedValue(updatedSettings);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(admin.accessToken))
          .send({ notifications: { browserEnabled: false } })
          .expect(200);

        expect(response.body.data).toBeDefined();
        expect(response.body.data.notifications.browserEnabled).toBe(false);
      });
    });

    describe('Contributor Role', () => {
      it('should NOT have access to user management', async () => {
        const contributor = await createMembershipContributor(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(contributor.accessToken))
          .expect(403);

        expect(response.body).toHaveProperty('code');
        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should NOT have access to system settings write', async () => {
        const contributor = await createMembershipContributor(context);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(contributor.accessToken))
          .send({ notifications: { browserEnabled: false } })
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should have access to own user settings', async () => {
        const contributor = await createMembershipContributor(context);

        const settings = createMockUserSettings({
          userId: contributor.id,
        });

        context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(contributor.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should have access to own profile (auth/me)', async () => {
        const contributor = await createMembershipContributor(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/auth/me')
          .set(authHeader(contributor.accessToken))
          .expect(200);

        expect(response.body.data.email).toBe(contributor.email);
      });
    });

    describe('Viewer Role', () => {
      it('should NOT have access to user management', async () => {
        const viewer = await createMembershipViewer(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/users')
          .set(authHeader(viewer.accessToken))
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should NOT have access to system settings', async () => {
        const viewer = await createMembershipViewer(context);

        const response = await request(context.app.getHttpServer())
          .patch('/api/system-settings')
          .set(authHeader(viewer.accessToken))
          .send({ notifications: { browserEnabled: false } })
          .expect(403);

        expect(response.body.code).toBe('FORBIDDEN');
      });

      it('should have read access to own user settings', async () => {
        const viewer = await createMembershipViewer(context);

        const settings = createMockUserSettings({
          userId: viewer.id,
        });

        context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

        const response = await request(context.app.getHttpServer())
          .get('/api/user-settings')
          .set(authHeader(viewer.accessToken))
          .expect(200);

        expect(response.body.data).toBeDefined();
      });

      it('should have access to own profile (auth/me)', async () => {
        const viewer = await createMembershipViewer(context);

        const response = await request(context.app.getHttpServer())
          .get('/api/auth/me')
          .set(authHeader(viewer.accessToken))
          .expect(200);

        expect(response.body.data.email).toBe(viewer.email);
      });
    });
  });

  describe('Permission-Based Access', () => {
    it('should allow users:read permission to list users', async () => {
      const admin = await createMembershipAdmin(context);

      context.prismaMock.user.findMany.mockResolvedValue([]);
      context.prismaMock.user.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
      expect(Array.isArray(response.body.data.items)).toBe(true);
    });

    it('should deny without users:read permission', async () => {
      const viewer = await createMembershipViewer(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should deny without system_settings:write permission', async () => {
      const viewer = await createMembershipViewer(context);

      const response = await request(context.app.getHttpServer())
        .patch('/api/system-settings')
        .set(authHeader(viewer.accessToken))
        .send({ notifications: { browserEnabled: true } })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });

    it('should allow user_settings:read permission to read own settings', async () => {
      const contributor = await createMembershipContributor(context);

      const settings = createMockUserSettings({
        userId: contributor.id,
      });

      context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(contributor.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });
  });

  describe('Guard Combination', () => {
    it('should require both role and permission when both specified', async () => {
      const admin = await createMembershipAdmin(context);

      context.prismaMock.user.findMany.mockResolvedValue([]);
      context.prismaMock.user.count.mockResolvedValue(0);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should fail if role matches but permission missing', async () => {
      const viewer = await createMembershipViewer(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
    });
  });

  describe('Self-Resource Access', () => {
    it('should allow user to access own settings regardless of role', async () => {
      const viewer = await createMembershipViewer(context);

      const settings = createMockUserSettings({
        userId: viewer.id,
      });

      context.prismaMock.userSettings.findUnique.mockResolvedValue(settings);

      const response = await request(context.app.getHttpServer())
        .get('/api/user-settings')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data).toBeDefined();
    });

    it('should allow user to access own profile', async () => {
      const viewer = await createMembershipViewer(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(response.body.data.id).toBe(viewer.id);
      expect(response.body.data.email).toBe(viewer.email);
    });
  });
  describe('Domain permissions are held through the membership (org role)', () => {
    const emptyDomainReads = () => {
      const m = context.prismaMock;
      m.transcript.findMany.mockResolvedValue([]);
      m.transcript.count.mockResolvedValue(0);
      m.transcriptShare.findMany.mockResolvedValue([]);
      m.note.findMany.mockResolvedValue([]);
      m.note.count.mockResolvedValue(0);
      m.noteTemplate.findMany.mockResolvedValue([]);
      m.noteTemplate.count.mockResolvedValue(0);
      m.userHiddenNoteTemplate.findMany.mockResolvedValue([]);
      m.kgAttributeDef.findMany.mockResolvedValue([]);
    };

    const DOMAIN_READS = [
      ['transcripts:read', '/api/transcripts'],
      ['notes:read', '/api/notes'],
      ['note_templates:read', '/api/note-templates'],
      ['graph:read', '/api/graph/ontology'],
    ] as const;

    beforeEach(emptyDomainReads);

    it('builds the Viewer the way production stores one: no system role, one org-role membership', async () => {
      const viewer = await createMembershipViewer(context);

      expect(viewer.roles).toEqual(['viewer']);

      const stored = await context.prismaMock.user.findUnique({ where: { id: viewer.id } });

      expect(stored.userRoles).toEqual([]);
      expect(stored.memberships).toHaveLength(1);
      expect(stored.memberships[0].role.name).toBe('viewer');
    });

    it.each(DOMAIN_READS)('lets a Viewer through %s on GET %s (via the membership)', async (_permission, path) => {
      const viewer = await createMembershipViewer(context);

      await request(context.app.getHttpServer()).get(path).set(authHeader(viewer.accessToken)).expect(200);
    });

    it.each(DOMAIN_READS)('lets a Contributor through %s on GET %s (via the membership)', async (_permission, path) => {
      const contributor = await createMembershipContributor(context);

      await request(context.app.getHttpServer()).get(path).set(authHeader(contributor.accessToken)).expect(200);
    });

    it.each(DOMAIN_READS)('lets an Admin through %s on GET %s (via org_admin, not the admin role)', async (_permission, path) => {
      const admin = await createMembershipAdmin(context);

      await request(context.app.getHttpServer()).get(path).set(authHeader(admin.accessToken)).expect(200);
    });

    it.each(DOMAIN_READS)('refuses %s on GET %s to an admin with NO org_admin membership', async (_permission, path) => {
      // Migration 20261015125334 deleted the `admin` grants of the eight
      // permissions: the system role operates the deployment, it does not read
      // anybody's transcripts. An admin reaches them only through `org_admin`.
      const systemOnly = await createMembershipUser(context, { systemRoles: ['admin'], orgRole: null });

      await request(context.app.getHttpServer())
        .get(path)
        .set(authHeader(systemOnly.accessToken))
        .expect(403);
    });

    it.each(DOMAIN_READS)('refuses %s on GET %s to an authenticated user with no membership', async (_permission, path) => {
      const stranger = await createMembershipUser(context, { orgRole: null });

      await request(context.app.getHttpServer())
        .get(path)
        .set(authHeader(stranger.accessToken))
        .expect(403);
    });

    it('lets a Viewer write transcripts, as the seed grants (transcripts:write is a viewer permission)', async () => {
      const viewer = await createMembershipViewer(context);

      // An invalid body proves the guard let the request through: a refused
      // caller would get 403 before validation ever ran.
      const response = await request(context.app.getHttpServer())
        .post('/api/transcripts')
        .set(authHeader(viewer.accessToken))
        .send({});

      expect([400, 422]).toContain(response.status);
    });

    it('exposes all eight KVox permissions on the Viewer principal returned by /api/auth/me', async () => {
      const viewer = await createMembershipViewer(context);

      const response = await request(context.app.getHttpServer())
        .get('/api/auth/me')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      const permissions: string[] = response.body.data.permissions ?? [];

      for (const permission of KVOX_DOMAIN_PERMISSIONS) {
        expect(permissions).toContain(permission);
      }
    });

    it('still refuses a Viewer the administrative surface the membership does not carry', async () => {
      const viewer = await createMembershipViewer(context);

      await request(context.app.getHttpServer())
        .get('/api/users')
        .set(authHeader(viewer.accessToken))
        .expect(403);
    });
  });
});
