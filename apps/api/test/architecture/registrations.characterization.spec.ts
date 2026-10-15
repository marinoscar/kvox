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
import {
  ADMIN_ONBOARDING_STEPS,
  USER_ONBOARDING_STEPS,
} from '../../src/onboarding/onboarding-steps';
import { NOTIFICATION_EVENTS } from '../../src/notifications/notification-events';
import { EMAIL_TEMPLATES } from '../../src/email/templates';
import { JOB_TYPE_LABELS } from '../../src/jobs/job-type-labels';
import {
  USER_DATA_SCOPES,
  scopeIncludes,
} from '../../src/user-data/job-types';
import { JobsService } from '@marinoscar/platform-api/jobs';

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

/** The categories `scopeIncludes` can be asked about, in declaration order. */
const SCOPE_CATEGORIES = [
  'transcripts',
  'notes',
  'noteTemplates',
  'files',
  'credentials',
  'onboarding',
  'graph',
  'ask',
] as const;

describe('Domain registrations characterization', () => {
  // ---------------------------------------------------------------------------
  // Pure values
  // ---------------------------------------------------------------------------

  describe('pure registry values', () => {
    it('ADMIN_ONBOARDING_STEPS keys, in array order', () => {
      expect(ADMIN_ONBOARDING_STEPS.map((s) => s.key)).toMatchSnapshot();
    });

    it('USER_ONBOARDING_STEPS keys, in array order', () => {
      expect(USER_ONBOARDING_STEPS.map((s) => s.key)).toMatchSnapshot();
    });

    it('onboarding step metadata (order, audience, tier, skippable, permission, href)', () => {
      const describeStep = (
        s: {
          key: string;
          audience: string;
          tier: string;
          skippable: boolean;
          permission?: string;
          title: string;
          description: string;
          actionLabel: string;
          href: string;
        },
        index: number,
      ) => ({
        position: index,
        key: s.key,
        audience: s.audience,
        tier: s.tier,
        skippable: s.skippable,
        permission: s.permission ?? null,
        title: s.title,
        description: s.description,
        actionLabel: s.actionLabel,
        href: s.href,
      });

      expect({
        admin: ADMIN_ONBOARDING_STEPS.map(describeStep),
        user: USER_ONBOARDING_STEPS.map(describeStep),
      }).toMatchSnapshot();
    });

    it('NOTIFICATION_EVENTS, in declared order', () => {
      expect(NOTIFICATION_EVENTS).toMatchSnapshot();
    });

    it('Object.keys(EMAIL_TEMPLATES), in registration order', () => {
      expect(Object.keys(EMAIL_TEMPLATES)).toMatchSnapshot();
    });

    it('JOB_TYPE_LABELS, in declared order', () => {
      expect(Object.entries(JOB_TYPE_LABELS)).toMatchSnapshot();
    });

    it('USER_DATA_SCOPES, in declared order', () => {
      expect([...USER_DATA_SCOPES]).toMatchSnapshot();
    });

    it('the full scopeIncludes(scope, category) matrix', () => {
      const matrix: Record<string, Record<string, boolean>> = {};
      for (const scope of USER_DATA_SCOPES) {
        matrix[scope] = {};
        for (const category of SCOPE_CATEGORIES) {
          matrix[scope][category] = scopeIncludes(scope, category);
        }
      }
      expect(matrix).toMatchSnapshot();
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
      context.prismaMock.userAiCredential.findUnique.mockResolvedValue(null);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    const server = () => context.app.getHttpServer();

    it('GET /api/onboarding (Viewer)', async () => {
      const viewer = await createMockViewerUser(context);

      const response = await request(server())
        .get('/api/onboarding')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });

    it('GET /api/onboarding (Admin)', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });

    it('GET /api/admin/onboarding (Admin)', async () => {
      const admin = await createMockAdminUser(context);

      const response = await request(server())
        .get('/api/admin/onboarding')
        .set(authHeader(admin.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
    });

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

    it('GET /api/user-data/summary (nothing held, no deletion in flight)', async () => {
      const viewer = await createMockViewerUser(context);

      context.prismaMock.storageObject.aggregate.mockResolvedValue({
        _count: { _all: 0 },
        _sum: { size: null },
      });
      context.prismaMock.note.findMany.mockResolvedValue([]);
      context.prismaMock.noteTemplate.count.mockResolvedValue(0);
      context.prismaMock.userAiCredential.count.mockResolvedValue(0);
      context.prismaMock.personalAccessToken.count.mockResolvedValue(0);
      context.prismaMock.kgEntity.count.mockResolvedValue(0);
      context.prismaMock.kgItem.count.mockResolvedValue(0);
      context.prismaMock.askConversation.count.mockResolvedValue(0);
      context.prismaMock.job.findFirst.mockResolvedValue(null);

      const response = await request(server())
        .get('/api/user-data/summary')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
      // The wire-visible key order of the Danger Zone summary, called out on
      // its own so a reorder is unmistakable in a failing diff.
      expect(Object.keys(response.body.data)).toMatchSnapshot();
    });

    it('GET /api/user-data/summary (populated, deletion in flight)', async () => {
      const viewer = await createMockViewerUser(context);

      context.prismaMock.transcript.count.mockResolvedValue(3);
      context.prismaMock.note.count.mockResolvedValue(5);
      context.prismaMock.note.findMany.mockResolvedValue([]);
      context.prismaMock.storageObject.aggregate.mockResolvedValue({
        _count: { _all: 2 },
        _sum: { size: BigInt(2048) },
      });
      context.prismaMock.noteTemplate.count.mockResolvedValue(4);
      context.prismaMock.userAiCredential.count.mockResolvedValue(1);
      context.prismaMock.personalAccessToken.count.mockResolvedValue(2);
      context.prismaMock.kgEntity.count.mockResolvedValue(7);
      context.prismaMock.kgItem.count.mockResolvedValue(9);
      context.prismaMock.askConversation.count.mockResolvedValue(6);
      context.prismaMock.job.findFirst.mockResolvedValue({
        id: '22222222-2222-4222-8222-222222222222',
        type: 'user.data.purge',
        status: 'pending',
        createdAt: FIXED_DATE,
        payload: { userId: viewer.id, scope: 'notes', requestId: 'req' },
      });

      const response = await request(server())
        .get('/api/user-data/summary')
        .set(authHeader(viewer.accessToken))
        .expect(200);

      expect(stableBody(response.body)).toMatchSnapshot();
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
