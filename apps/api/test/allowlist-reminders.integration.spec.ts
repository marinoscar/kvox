// =============================================================================
// Allowlist invitation reminders (issue #465, epic #462; feature #301)
// =============================================================================
//
// The platform's `/api/allowlist` has no seam for "remind the invitee", so KVox
// owns two routes beside it, backed by the `kvox_allowlist_reminders` side table
// (no foreign key to `allowed_emails`, which is read only):
//
//   POST /api/allowlist/:id/reminder   allowlist:write
//   GET  /api/allowlist/reminders?ids= allowlist:read
//
// This spec drives them through the whole `AppModule` over a MOCKED Prisma
// client. The reminder statements are raw SQL, so the mock answers
// `$queryRaw` / `$executeRaw`; what the real SQL does (the `ON CONFLICT`
// increment, the orphan `DELETE .. NOT EXISTS`) is exercised against Postgres
// by the DB tier, not here.
//
// ⚠ The ordering assertion is the one that matters most: `notifyAddress` is
// called AFTER the counter write, and never inside a `$transaction` (root
// invariant: notify() runs after the triggering write commits).
// =============================================================================

import request from 'supertest';
import { randomUUID } from 'crypto';

import { NotificationsService } from '../src/notifications/notifications.service';
import { TestContext, closeTestApp, createTestApp } from './helpers/test-app.helper';
import { authHeader } from './helpers/auth-mock.helper';
import { createMembershipAdmin, createMembershipUser } from './helpers/membership-user.helper';
import { setupBaseMocks } from './fixtures/mock-setup.helper';
import { resetPrismaMock } from './mocks/prisma.mock';

const ENTRY_ID = '3f1a6c52-6a0e-4f0e-9d2c-0e8f6f1b7a11';
const OTHER_ID = '9b2d8f10-1c3e-4a7b-8d55-2f6e0c4a9b22';

const entry = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  email: 'invitee@example.com',
  notes: 'private annotation about the invitee',
  addedAt: new Date('2026-09-01T10:00:00.000Z'),
  claimedAt: null,
  claimedById: null,
  addedBy: { id: 'admin-1', email: 'admin@example.com' },
  ...overrides,
});

describe('Allowlist reminders (Integration)', () => {
  let context: TestContext;
  let prismaMock: any;
  let notifyAddress: jest.SpyInstance;
  /** Ordered record of the statements and the notification, to prove commit-before-notify. */
  let events: string[];

  beforeAll(async () => {
    context = await createTestApp({ useMockDatabase: true });
    prismaMock = context.prismaMock;
  });

  afterAll(async () => {
    notifyAddress?.mockRestore();
    await closeTestApp(context);
  });

  beforeEach(() => {
    resetPrismaMock();
    setupBaseMocks();
    events = [];

    prismaMock.auditEvent.create.mockResolvedValue({} as never);
    prismaMock.$transaction.mockImplementation(async (arg: any) => {
      events.push('transaction');
      return typeof arg === 'function' ? arg(prismaMock) : Promise.all(arg);
    });

    notifyAddress?.mockRestore();
    notifyAddress = jest
      .spyOn(context.module.get(NotificationsService), 'notifyAddress')
      .mockImplementation(async () => {
        events.push('notify');
      });
  });

  const admin = () => createMembershipAdmin(context);

  /** Makes the counter write answer `count`, recording that it ran. */
  function counterWrites(count: number, at = new Date('2026-10-15T12:00:00.000Z')) {
    prismaMock.$queryRaw.mockImplementation(async () => {
      events.push('write');
      return [{ reminder_count: count, last_reminder_at: at }];
    });
  }

  describe('POST /api/allowlist/:id/reminder', () => {
    it('answers 404 when the allowlist entry does not exist', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(null);
      const user = await admin();

      const response = await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(notifyAddress).not.toHaveBeenCalled();
    });

    it('answers 409 with details.reason already_claimed for a claimed entry, writing and sending nothing', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(
        entry({ claimedById: randomUUID(), claimedAt: new Date('2026-09-02T10:00:00.000Z') }),
      );
      const user = await admin();

      const response = await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(409);

      expect(response.body.details).toEqual({ reason: 'already_claimed' });
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
      expect(notifyAddress).not.toHaveBeenCalled();
    });

    it('increments the count and returns the new state', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      const user = await admin();

      counterWrites(1);
      const first = await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      counterWrites(2, new Date('2026-10-16T08:30:00.000Z'));
      const second = await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(first.body.data.reminderCount).toBe(1);
      expect(first.body.data.lastReminderAt).toBe('2026-10-15T12:00:00.000Z');
      expect(second.body.data.reminderCount).toBe(2);
      expect(second.body.data.lastReminderAt).toBe('2026-10-16T08:30:00.000Z');
    });

    it('does the increment in ONE atomic SQL statement, never a read-modify-write', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      counterWrites(1);
      const user = await admin();

      await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);

      const sql = (prismaMock.$queryRaw.mock.calls[0][0] as TemplateStringsArray).join('?');

      expect(sql).toMatch(/INSERT INTO kvox_allowlist_reminders/);
      expect(sql).toMatch(/ON CONFLICT \(allowed_email_id\) DO UPDATE/);
      expect(sql).toMatch(/reminder_count = kvox_allowlist_reminders\.reminder_count \+ 1/);
      // allowed_emails is only ever READ: no write goes through its model.
      expect(prismaMock.allowedEmail.update).not.toHaveBeenCalled();
    });

    it('raises the notification AFTER the counter write, outside any $transaction', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      counterWrites(1);
      const user = await admin();

      await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(events).toEqual(['write', 'notify']);
      expect(events).not.toContain('transaction');
      expect(prismaMock.$transaction).not.toHaveBeenCalled();
    });

    it('sends allowlist.invitation_reminder to the invitee without the private admin notes', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      counterWrites(1);
      const user = await admin();

      await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(notifyAddress).toHaveBeenCalledTimes(1);

      const [eventKey, address, data] = notifyAddress.mock.calls[0];

      expect(eventKey).toBe('allowlist.invitation_reminder');
      expect(address).toBe('invitee@example.com');
      expect(data).toMatchObject({ recipientEmail: 'invitee@example.com', invitedBy: 'admin@example.com' });
      expect(JSON.stringify(data)).not.toContain('private annotation');
    });

    it('writes one allowlist.reminder_sent audit row naming the admin and the entry', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      counterWrites(3);
      const user = await admin();

      await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      const actions = prismaMock.auditEvent.create.mock.calls.map((call: any[]) => call[0].data);
      const reminderRows = actions.filter((data: any) => data.action === 'allowlist.reminder_sent');

      expect(reminderRows).toHaveLength(1);
      expect(reminderRows[0]).toMatchObject({ actorUserId: user.id, targetId: ENTRY_ID });
    });

    it('still answers 200 and still notifies when the audit write fails', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      counterWrites(1);
      prismaMock.auditEvent.create.mockRejectedValue(new Error('audit down'));
      const user = await admin();

      await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(notifyAddress).toHaveBeenCalledTimes(1);
    });

    it('answers 403 without allowlist:write (a Viewer)', async () => {
      prismaMock.allowedEmail.findUnique.mockResolvedValue(entry());
      const viewer = await createMembershipUser(context, { orgRole: 'viewer' });

      const response = await request(context.app.getHttpServer())
        .post(`/api/allowlist/${ENTRY_ID}/reminder`)
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(prismaMock.allowedEmail.findUnique).not.toHaveBeenCalled();
      expect(notifyAddress).not.toHaveBeenCalled();
    });

    it('answers 401 without a token', async () => {
      await request(context.app.getHttpServer()).post(`/api/allowlist/${ENTRY_ID}/reminder`).expect(401);
    });

    it('answers 400 for an id that is not a UUID, before reading anything', async () => {
      const user = await admin();

      await request(context.app.getHttpServer())
        .post('/api/allowlist/not-a-uuid/reminder')
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(prismaMock.allowedEmail.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/allowlist/reminders', () => {
    it('returns { allowedEmailId, reminderCount, lastReminderAt } for each reminded entry', async () => {
      const at = new Date('2026-10-15T12:00:00.000Z');
      prismaMock.$executeRaw.mockResolvedValue(0);
      prismaMock.$queryRaw.mockResolvedValue([
        { allowed_email_id: ENTRY_ID, reminder_count: 2, last_reminder_at: at },
      ]);
      const user = await admin();

      const response = await request(context.app.getHttpServer())
        .get(`/api/allowlist/reminders?ids=${ENTRY_ID},${OTHER_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual([
        { allowedEmailId: ENTRY_ID, reminderCount: 2, lastReminderAt: '2026-10-15T12:00:00.000Z' },
      ]);
    });

    it('deletes orphaned rows BEFORE it reads, and reads through a join to allowed_emails', async () => {
      prismaMock.$executeRaw.mockImplementation(async () => {
        events.push('sweep');
        return 1;
      });
      prismaMock.$queryRaw.mockImplementation(async () => {
        events.push('read');
        return [];
      });
      const user = await admin();

      await request(context.app.getHttpServer())
        .get(`/api/allowlist/reminders?ids=${ENTRY_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(events).toEqual(['sweep', 'read']);

      const sweepSql = (prismaMock.$executeRaw.mock.calls[0][0] as TemplateStringsArray).join('?');
      // `Prisma.sql` object: its fragments carry the statement text.
      const readText = JSON.stringify(prismaMock.$queryRaw.mock.calls[0][0]);

      expect(sweepSql).toMatch(/DELETE FROM kvox_allowlist_reminders/);
      expect(sweepSql).toMatch(/NOT EXISTS \(SELECT 1 FROM allowed_emails/);
      expect(sweepSql).toMatch(/LIMIT/);
      expect(readText).toMatch(/JOIN allowed_emails/);
    });

    it('still answers when the orphan sweep fails (best effort)', async () => {
      prismaMock.$executeRaw.mockRejectedValue(new Error('lock timeout'));
      prismaMock.$queryRaw.mockResolvedValue([]);
      const user = await admin();

      const response = await request(context.app.getHttpServer())
        .get(`/api/allowlist/reminders?ids=${ENTRY_ID}`)
        .set(authHeader(user.accessToken))
        .expect(200);

      expect(response.body.data).toEqual([]);
    });

    it('answers 400 for a missing or malformed ids list without touching the database', async () => {
      const user = await admin();

      await request(context.app.getHttpServer())
        .get('/api/allowlist/reminders')
        .set(authHeader(user.accessToken))
        .expect(400);
      await request(context.app.getHttpServer())
        .get('/api/allowlist/reminders?ids=nope')
        .set(authHeader(user.accessToken))
        .expect(400);

      expect(prismaMock.$executeRaw).not.toHaveBeenCalled();
      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('answers 403 without allowlist:read (a Viewer)', async () => {
      const viewer = await createMembershipUser(context, { orgRole: 'viewer' });

      await request(context.app.getHttpServer())
        .get(`/api/allowlist/reminders?ids=${ENTRY_ID}`)
        .set(authHeader(viewer.accessToken))
        .expect(403);

      expect(prismaMock.$queryRaw).not.toHaveBeenCalled();
    });

    it('is not shadowed by the platform route /api/allowlist/:id (reminders is not parsed as an id)', async () => {
      prismaMock.$executeRaw.mockResolvedValue(0);
      prismaMock.$queryRaw.mockResolvedValue([]);
      const user = await admin();

      const response = await request(context.app.getHttpServer())
        .get(`/api/allowlist/reminders?ids=${ENTRY_ID}`)
        .set(authHeader(user.accessToken));

      expect(response.status).toBe(200);
    });
  });
});
