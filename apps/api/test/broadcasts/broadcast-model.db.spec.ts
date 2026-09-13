// =============================================================================
// NotificationBroadcast schema: fields, defaults, enum values and indexes
// (issue #320, epic #319)
// =============================================================================
//
// Schema-only issue — no service, no controller, no handler exists yet for
// this model, so there is nothing downstream to integration-test. What this
// file locks down is the contract those later issues (#321-#324) will build
// on top of, in the same two-part shape `test/jobs/job-model-fields.spec.ts`
// and `test/nodes/worker-node-model-fields.spec.ts` use for their own
// schema-only issues:
//
//   - THE GENERATED FIELD/ENUM SET, asserted against
//     `Prisma.NotificationBroadcastScalarFieldEnum` and
//     `NotificationBroadcastStatus` (both generated straight from
//     `prisma/schema.prisma` by `prisma generate`) rather than a hand-copied
//     list read off the schema file, so a column or enum member renamed or
//     dropped later fails HERE, naming the field, instead of surfacing as a
//     silently `undefined` property in a service built on top of this model.
//     This half needs no database — it is checking what `prisma generate`
//     already produced from the schema — and runs unconditionally below.
//
//   - THE TWO HAND-DECLARED INDEXES AND THE COLUMN DEFAULTS, which — unlike
//     the field set above — are facts about what the migration actually
//     applied to a real table, not about the generated client. Those only
//     exist once `20260907120000_add_notification_broadcasts/migration.sql`
//     has actually run against a live Postgres, so this half is gated behind
//     `resolveDbSuite` (extracted in #260 from `job-schema-indexes.db.spec.ts`,
//     see `db-test-support.ts`) exactly like every other `*.db.spec.ts` in
//     this repo: real assertions when a database is reachable, a clear skip
//     warning instead of a confusing connection error when it isn't.
//
// THIS IS A `*.db.spec.ts` FILE, deliberately excluded from `npm test`/
// `test:unit`/`test:cov`/`test:ci` (see apps/api/package.json's
// testPathIgnorePatterns). It runs only via `npm run test:db`, which CI's
// `smoke` job invokes right after `prisma:migrate` and before `prisma:seed`
// (see .github/workflows/ci.yml) — the migration has to have actually run
// for the index-existence and default-value assertions below to mean
// anything. Locally, `npm run test:db` needs a real Postgres reachable at
// POSTGRES_HOST/POSTGRES_PORT with the migrations applied; see
// `resolveDbSuite` for what happens without one.
// =============================================================================

import { NotificationBroadcastStatus, Prisma } from '@prisma/client';

import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

describe('Prisma.NotificationBroadcastScalarFieldEnum', () => {
  it('has exactly the field names NotificationBroadcast is documented to have', () => {
    const expected = [
      'id',
      'title',
      'body',
      'link',
      'ctaLabel',
      'eventKey',
      'channels',
      'status',
      'scheduledFor',
      'startedAt',
      'finishedAt',
      'canceledAt',
      'audienceCutoff',
      'cursorUserId',
      'recipientsTargeted',
      'recipientsDispatched',
      'lastError',
      'createdById',
      'createdAt',
      'updatedAt',
    ].sort();

    const actual = Object.keys(Prisma.NotificationBroadcastScalarFieldEnum).sort();

    expect(actual).toEqual(expected);
  });

  it('maps every field name to itself, matching how Prisma builders reference it', () => {
    for (const field of Object.keys(Prisma.NotificationBroadcastScalarFieldEnum)) {
      expect(
        Prisma.NotificationBroadcastScalarFieldEnum[
          field as keyof typeof Prisma.NotificationBroadcastScalarFieldEnum
        ],
      ).toBe(field);
    }
  });
});

describe('NotificationBroadcastStatus enum', () => {
  it('has exactly the six documented states, including the currently-unreachable `draft`', () => {
    // `draft` is not written or read by any route in epic #319 — it exists
    // only so a future "save and finish later" composer does not need a
    // migration to add it, since `ALTER TYPE ... ADD VALUE` cannot run
    // inside the transaction a Prisma migration is wrapped in. See the
    // block comment above the `NotificationBroadcast` model in
    // prisma/schema.prisma. Do not delete it from this list as "unused".
    expect(Object.keys(NotificationBroadcastStatus).sort()).toEqual(
      ['draft', 'scheduled', 'sending', 'sent', 'canceled', 'failed'].sort(),
    );
  });

  it('maps every member to itself, matching how Prisma builders reference it', () => {
    for (const key of Object.keys(NotificationBroadcastStatus)) {
      expect(
        NotificationBroadcastStatus[key as keyof typeof NotificationBroadcastStatus],
      ).toBe(key);
    }
  });
});

const HAND_DECLARED_INDEX_NAMES = [
  'notification_broadcasts_status_scheduled_for_idx',
  'notification_broadcasts_created_at_idx',
];

const { describeWithDb } = resolveDbSuite('broadcast-model.db.spec');

describeWithDb('NotificationBroadcast schema (real Postgres)', () => {
  let prisma: ReturnType<typeof createDbClient>;

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    await prisma.notificationBroadcast.deleteMany({
      where: { eventKey: { startsWith: 'test.broadcast-model' } },
    });
  });

  it('creates both indexes declared with @@index on the model', async () => {
    const rows = await prisma.$queryRaw<Array<{ indexname: string }>>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'notification_broadcasts' AND indexname = ANY(${HAND_DECLARED_INDEX_NAMES})
    `;
    expect(rows.map((r) => r.indexname).sort()).toEqual([...HAND_DECLARED_INDEX_NAMES].sort());
  });

  it('applies the documented column defaults to a minimally-specified row', async () => {
    const broadcast = await prisma.notificationBroadcast.create({
      data: {
        title: 'Test broadcast',
        body: 'Test body',
        eventKey: 'test.broadcast-model.defaults',
        channels: ['browser'],
      },
    });

    // status defaults to 'scheduled' — 'draft' is reachable by no route in
    // this epic, so nothing should default a fresh row into it.
    expect(broadcast.status).toBe('scheduled');
    // recipientsDispatched is a running attempt count that starts at zero.
    expect(broadcast.recipientsDispatched).toBe(0);
    // recipientsTargeted is a snapshot that does not exist until the
    // fan-out starts — nullable, and null on a freshly created row.
    expect(broadcast.recipientsTargeted).toBeNull();
    // Lifecycle timestamps are unset until their respective transitions.
    expect(broadcast.startedAt).toBeNull();
    expect(broadcast.finishedAt).toBeNull();
    expect(broadcast.canceledAt).toBeNull();
    expect(broadcast.audienceCutoff).toBeNull();
    expect(broadcast.cursorUserId).toBeNull();
    expect(broadcast.lastError).toBeNull();
    expect(broadcast.createdById).toBeNull();
    expect(broadcast.createdAt).toBeInstanceOf(Date);
    expect(broadcast.updatedAt).toBeInstanceOf(Date);
  });

  it('sets created_by_id to null, without deleting the broadcast, when the creating admin is deleted', async () => {
    const admin = await prisma.user.create({
      data: {
        email: `broadcast-model-author-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test`,
      },
    });

    const broadcast = await prisma.notificationBroadcast.create({
      data: {
        title: 'Test broadcast (author cascade)',
        body: 'Test body',
        eventKey: 'test.broadcast-model.author-setnull',
        channels: ['browser'],
        createdById: admin.id,
      },
    });

    await prisma.user.delete({ where: { id: admin.id } });

    const reloaded = await prisma.notificationBroadcast.findUniqueOrThrow({
      where: { id: broadcast.id },
    });
    expect(reloaded.createdById).toBeNull();
    expect(reloaded.id).toBe(broadcast.id);
  });
});
