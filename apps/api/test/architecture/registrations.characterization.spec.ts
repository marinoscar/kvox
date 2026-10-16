import request from 'supertest';
import {
  TestContext,
  createTestApp,
  closeTestApp,
} from '../helpers/test-app.helper';
import { resetPrismaMock } from '../mocks/prisma.mock';
import { setupBaseMocks } from '../fixtures/mock-setup.helper';
import {
  authHeader,
  createMockAdminUser,
  createMockViewerUser,
} from '../helpers/auth-mock.helper';
import { emailTemplateRegistry } from '@marinoscar/platform-api/email';
import { listNotificationEvents } from '@marinoscar/platform-api/notifications';
// Fills the notification and email registries (the platform's, then this app's), so the two
// pure-value cases below read them without booting AppModule.
import '../../src/platform/notifications/notification.manifest';
import { JobHandlerRegistry, JobsService, jobTypeLabels } from '@marinoscar/platform-api/jobs';

// =============================================================================
// Domain-registration characterization (issue #460, step 2)
// =============================================================================
//
// WHY THIS EXISTS. Issue #460 moves every domain entry out of the base modules'
// hard-coded lists (onboarding steps and facts, notification events and their
// email/browser bindings, email templates, job-type labels, user-data scopes
// and categories) into registries that the domain modules fill from
// `kvox.manifest.ts`. The refactor is only allowed to be a no-op on the wire:
// the same lists, in the same ORDER (onboarding order, the notification
// settings matrix, the Danger Zone summary keys and the scope matrix are all
// wire-visible), the same labels, the same response bodies.
//
// This spec pins all of that with Jest snapshots written on the UNCHANGED code.
// If a snapshot fails after the refactor, the refactor changed behaviour: fix
// the refactor, NEVER update or hand-edit the snapshot.
//
// Imports use today's names only. Where one of them later becomes a getter or a
// function (`NOTIFICATION_EVENTS`, `EMAIL_TEMPLATES`, `JOB_TYPE_LABELS`,
// `USER_DATA_SCOPES`, the step arrays), the registry-backed form must stay
// observably identical, which is exactly what is pinned here.
//
// Issue #470 moved the notification events and email templates to the platform
// registries (`listNotificationEvents()`, `emailTemplateRegistry.ids()`); the
// snapshots keep their original titles. The ONE intended difference is the
// order of `allowlist.invitation_reminder` (now after `security.role_changed`,
// the platform's identity group order) and, with it, the template list.
//
// The onboarding cases (the step lists and the three onboarding responses) were retired by #481:
// onboarding is the platform slice now, its wire shape changed on purpose, and what pins it is
// `test/onboarding/onboarding-steps.spec.ts` and `test/onboarding/onboarding.integration.spec.ts`.
//
// Determinism: the only wall-clock values on the wire are masked by
// `stableBody` (the envelope's request instant and the jobs stats
// `generatedAt`); everything else comes from fixed mocks.
// =============================================================================

const FIXED_DATE = new Date('2026-01-01T00:00:00.000Z');

/**
 * Serialises a response body for snapshotting. The envelope's
 * `meta.timestamp` (request instant) and the jobs-stats `generatedAt` (read
 * from the clock) are replaced with placeholders, asserted to be ISO strings
 * first so their presence is still pinned. Key order is preserved.
 */
function stableBody(body: {
  meta?: { timestamp?: unknown };
  data?: { generatedAt?: unknown };
}): string {
  const copy = JSON.parse(JSON.stringify(body));
  expect(typeof copy.meta?.timestamp).toBe('string');
  copy.meta.timestamp = '<request timestamp>';
  if (copy.data && 'generatedAt' in copy.data) {
    expect(typeof copy.data.generatedAt).toBe('string');
    copy.data.generatedAt = '<generated at>';
  }
  return JSON.stringify(copy, null, 2);
}

describe('Domain registrations characterization', () => {
  // ---------------------------------------------------------------------------
  // Pure values
  // ---------------------------------------------------------------------------

  describe('pure registry values', () => {
    it('NOTIFICATION_EVENTS, in declared order', () => {
      expect(listNotificationEvents()).toMatchSnapshot();
    });

    it('Object.keys(EMAIL_TEMPLATES), in registration order', () => {
      expect(emailTemplateRegistry.ids()).toMatchSnapshot();
    });
  });

  // ---------------------------------------------------------------------------
  // Through the real guard stack
  // ---------------------------------------------------------------------------

  describe('HTTP responses', () => {
    let context: TestContext;

    beforeAll(async () => {
      context = await createTestApp({ useMockDatabase: true });
    }, 60000);

    afterAll(async () => {
      await closeTestApp(context);
    });

    beforeEach(() => {
      resetPrismaMock();
      setupBaseMocks();

      // A fresh deployment where nobody has created anything: one account, one
      // allowlist entry, no AI key. Explicit values, never left to `mockDeep`
      // (an unconfigured `count` answers `undefined`, an unconfigured
      // `findUnique` answers `undefined`, and both compare falsely by accident).
      context.prismaMock.transcript.count.mockResolvedValue(0);
      context.prismaMock.note.count.mockResolvedValue(0);
      context.prismaMock.user.count.mockResolvedValue(1);
      context.prismaMock.allowedEmail.count.mockResolvedValue(1);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const server = () => context.app.getHttpServer();

    it('GET /api/notifications/events', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get('/api/notifications/events')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });

    it('GET /api/notifications/config', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get('/api/notifications/config')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });

    it('every registered job handler has a registry label, and the retired example types keep theirs', () => {
      // Since #468 a handler declares its own `label` and the platform registry
      // records it on registration, so there is no per-domain label map to pin
      // (the map was snapshotted here before the port). `test/jobs/job-type-snapshot.spec.ts`
      // pins WHICH types must register; this pins that each of them reads as a
      // phrase, and that the two retired types still do.
      const registry = context.module.get(JobHandlerRegistry, { strict: false });
      const labels = jobTypeLabels();

      const unlabelled = registry
        .types()
        .filter((type) => !labels.get(type) || labels.get(type) === type);
      expect(unlabelled).toEqual([]);

      expect(labels.get('example.echo')).toBeTruthy();
      expect(labels.get('example.checksum')).toBeTruthy();
    });

    it('GET /api/admin/jobs/stats labels after enqueueing one job of each of three types', async () => {
      const admin = await createMockAdminUser(context);
      const jobs = context.module.get(JobsService, { strict: false });

      // One domain-transcription type, one domain-notes type, one base type:
      // the label of each must keep resolving through the registry.
      const types = ['transcription.submit', 'note.generate', 'user.data.purge'];
      const created: Array<{ type: string; status: string }> = [];

      context.prismaMock.job.create.mockImplementation(async ({ data }: any) => {
        const row = {
          id: `job-${created.length + 1}`,
          status: 'pending',
          attempts: 0,
          createdAt: FIXED_DATE,
          updatedAt: FIXED_DATE,
          ...data,
        };
        created.push({ type: row.type, status: row.status });
        return row;
      });

      for (const type of types) {
        await jobs.enqueue({ type, reason: 'upload' } as any);
      }
      expect(created.map((c) => c.type)).toEqual(types);

      context.prismaMock.job.groupBy.mockImplementation(async ({ by }: any) => {
        if (by.length === 1) {
          return [{ status: 'pending', _count: { _all: created.length } }];
        }
        return created.map((c) => ({
          type: c.type,
          status: c.status,
          _count: { _all: 1 },
        }));
      });
      context.prismaMock.job.count.mockResolvedValue(0);

      const response = await request(server())
        .get('/api/admin/jobs/stats')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });
  });
});
