// =============================================================================
// Real-Postgres test: the sharing RBAC matrix and immediate revocation
// (issue #29, epic #19, spec §6)
// =============================================================================
//
// Three of issue #29's acceptance criteria are claims about ROWS, not about a
// class, and a mock cannot prove any of them:
//
//   1. **The RBAC matrix.** Owner, editor, viewer and stranger across read,
//      play, export, edit, restore, share, delete and leave — and a stranger
//      always gets 404. Asserted over a mocked `transcriptShare.findUnique`
//      this would be asserting the arrangement the test itself just made; here
//      each actor's access is decided by a real `transcript_shares` row and a
//      real `transcripts.owner_id`.
//
//   2. **Revocation takes effect on the NEXT REQUEST.** The whole claim is that
//      there is no cached grant to invalidate — which is a statement about what
//      the second query sees after the first one's row is gone. A mock returns
//      whatever it was last told to, so it would "prove" this for an
//      implementation that cached aggressively.
//
//   3. **A role change takes effect immediately**, for the same reason.
//
// Plus the two facts the unique index enforces rather than the service:
// re-sharing updates one row instead of creating a second, and `@@unique` on
// `(transcript_id, user_id)` makes a competing pair unrepresentable.
//
// This is a `*.db.spec.ts` file, excluded from `npm test`/`test:unit`/
// `test:cov`/`test:ci` and run by `npm run test:db` (CI's `Smoke` job). See
// `../jobs/db-test-support.ts` for the reachability probe.
// =============================================================================

import { randomUUID } from 'node:crypto';

import { ConfigService } from '@nestjs/config';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import type { RequestUser } from '../../src/auth/interfaces/authenticated-user.interface';
import type { NotificationsService } from '../../src/notifications/notifications.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { ObjectsService } from '../../src/storage/objects/objects.service';
import type { StorageProvider } from '../../src/storage/providers/storage-provider.interface';
import type { TranscriptPipelineService } from '../../src/transcripts/transcript-pipeline.service';
import type { TranscriptionRuntimeService } from '../../src/transcripts/transcription-runtime.service';
import { ShareLookupThrottleService } from '../../src/transcripts/share-lookup-throttle.service';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from '../../src/transcripts/transcript-access.service';
import { TranscriptEditingService } from '../../src/transcripts/transcript-editing.service';
import { TranscriptMaterializeService } from '../../src/transcripts/transcript-materialize.service';
import { TranscriptObjectsService } from '../../src/transcripts/transcript-objects.service';
import {
  SHARE_RECIPIENT_NOT_FOUND_MESSAGE,
  TranscriptSharingService,
} from '../../src/transcripts/transcript-sharing.service';
import { TranscriptsService } from '../../src/transcripts/transcripts.service';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb } = resolveDbSuite('transcript-sharing.db.spec');

/** Everything this suite creates is prefixed so cleanup is unambiguous. */
const TITLE_PREFIX = 'i29-sharing-';
const EMAIL_PREFIX = 'i29-sharing';
const KEY_PREFIX = 'i29-sharing/';

/** The permissions every seeded role carries for transcripts (spec §6.2). */
const FULL_PERMISSIONS = ['transcripts:read', 'transcripts:write'];

describeWithDb('Transcript sharing (real Postgres)', () => {
  let prisma: PrismaClient;

  let access: TranscriptAccessService;
  let transcripts: TranscriptsService;
  let editing: TranscriptEditingService;
  let sharing: TranscriptSharingService;
  let notify: jest.Mock;

  let owner: RequestUser;
  let editor: RequestUser;
  let viewer: RequestUser;
  let stranger: RequestUser;
  let inactive: RequestUser;
  let sourceObjectId: string;

  function actor(id: string, email: string, permissions = FULL_PERMISSIONS): RequestUser {
    return { id, email, roles: ['Contributor'], permissions, isActive: true };
  }

  beforeAll(async () => {
    prisma = createDbClient();
    await prisma.$connect();

    const service = prisma as unknown as PrismaService;

    // A SIGNING STUB, not `TmpDirStorageProvider`: that double deliberately
    // throws for `getSignedDownloadUrl`, and nothing in this suite moves bytes
    // — the matrix's `play` row needs a URL to come back so that a 404 there
    // can only mean "no access", never "the double refused to sign".
    const storage = {
      getSignedDownloadUrl: jest.fn().mockResolvedValue('https://signed.example.test/audio'),
      getBucket: jest.fn().mockReturnValue('test-bucket'),
    } as unknown as StorageProvider;

    access = new TranscriptAccessService(service);

    const objects = new TranscriptObjectsService(
      service,
      { deleteManagedObject: jest.fn() } as unknown as ObjectsService,
      new ConfigService({}),
      storage,
    );

    const pipeline = {
      enqueuePurge: jest.fn().mockResolvedValue(true),
      enqueueSnapshot: jest.fn().mockResolvedValue(true),
      // #188's semantic re-index, stubbed. `TranscriptEditingService` AWAITS
      // it after every committed op batch and after a restore, so a missing
      // member is a TypeError that fails the suite, not a silent no-op.
      enqueueSearchIndex: jest.fn().mockResolvedValue(undefined),
      enqueueSubmit: jest.fn().mockResolvedValue(true),
      enqueueFirstPoll: jest.fn().mockResolvedValue(true),
    } as unknown as TranscriptPipelineService;

    transcripts = new TranscriptsService(
      service,
      { initUpload: jest.fn() } as unknown as ObjectsService,
      objects,
      access,
      pipeline,
      {} as unknown as TranscriptionRuntimeService,
    );

    editing = new TranscriptEditingService(
      service,
      access,
      new TranscriptMaterializeService(service, objects),
      pipeline,
    );

    notify = jest.fn().mockResolvedValue(undefined);

    sharing = new TranscriptSharingService(
      service,
      access,
      new ShareLookupThrottleService(),
      { notify } as unknown as NotificationsService,
      new ConfigService({ appUrl: 'https://app.example.test' }),
    );

    const accounts = await Promise.all(
      ['owner', 'editor', 'viewer', 'stranger'].map((name) =>
        prisma.user.create({
          data: {
            email: `${EMAIL_PREFIX}-${name}-${randomUUID()}@example.test`,
            displayName: `The ${name}`,
          },
        }),
      ),
    );

    [owner, editor, viewer, stranger] = accounts.map((account) =>
      actor(account.id, account.email),
    );

    const disabled = await prisma.user.create({
      data: {
        email: `${EMAIL_PREFIX}-inactive-${randomUUID()}@example.test`,
        displayName: 'Gone',
        isActive: false,
      },
    });

    inactive = actor(disabled.id, disabled.email);

    const source = await prisma.storageObject.create({
      data: {
        name: 'recording.m4a',
        size: BigInt(2048),
        mimeType: 'audio/mp4',
        storageKey: `${KEY_PREFIX}${randomUUID()}`,
        managedBy: 'transcripts',
        uploadedById: owner.id,
        // `ready`, so `signedUrlFor` actually signs: the `play` row of the
        // matrix must fail for LACK OF ACCESS, never for a half-uploaded
        // object, or a 404 would look like the rule working when it is not.
        status: 'ready',
      },
    });

    sourceObjectId = source.id;
  });

  afterAll(async () => {
    await cleanup();
    await prisma.storageObject.deleteMany({ where: { storageKey: { startsWith: KEY_PREFIX } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    await prisma.$disconnect();
  });

  afterEach(async () => {
    await cleanup();
    notify.mockClear();
  });

  async function cleanup(): Promise<void> {
    const where = { transcript: { title: { startsWith: TITLE_PREFIX } } };

    await prisma.transcriptShare.deleteMany({ where });
    await prisma.transcriptVersion.deleteMany({ where });
    await prisma.transcriptSegment.deleteMany({ where });
    await prisma.transcriptSpeaker.deleteMany({ where });
    await prisma.auditEvent.deleteMany({ where: { targetType: 'transcript' } });
    await prisma.transcript.deleteMany({ where: { title: { startsWith: TITLE_PREFIX } } });
  }

  // ---------------------------------------------------------------------------
  // Seeding: one ready transcript at version 1, with an editor and a viewer
  // ---------------------------------------------------------------------------

  interface Seed {
    transcriptId: string;
    speakerId: string;
    segmentId: string;
  }

  async function seed(options: { shares?: boolean } = {}): Promise<Seed> {
    const transcript = await prisma.transcript.create({
      data: {
        ownerId: owner.id,
        title: `${TITLE_PREFIX}${randomUUID()}`,
        sourceObjectId,
        provider: 'assemblyai',
        status: 'ready',
        transcriptionStatus: 'completed',
        playbackStatus: 'not_needed',
        currentVersion: 1,
        speakerCount: 1,
        wordCount: 3,
      },
    });

    const speaker = await prisma.transcriptSpeaker.create({
      data: {
        transcriptId: transcript.id,
        label: 'A',
        displayName: 'Speaker A',
        colorIndex: 0,
      },
    });

    const segment = await prisma.transcriptSegment.create({
      data: {
        transcriptId: transcript.id,
        speakerId: speaker.id,
        startMs: 0,
        endMs: 3_000,
        ordinal: 1000,
        text: 'one two three',
        words: [
          { t: 'one', s: 0, e: 900, c: 0.9 },
          { t: 'two', s: 900, e: 1800, c: 0.9 },
          { t: 'three', s: 1800, e: 3000, c: 0.9 },
        ],
        wordsAlignment: 'exact',
        origin: 'ai',
      },
    });

    await prisma.transcriptVersion.create({
      data: {
        transcriptId: transcript.id,
        version: 1,
        kind: 'ai_original',
        summary: 'Original transcription',
        ops: [],
      },
    });

    if (options.shares !== false) {
      await prisma.transcriptShare.createMany({
        data: [
          { transcriptId: transcript.id, userId: editor.id, role: 'editor', grantedById: owner.id },
          { transcriptId: transcript.id, userId: viewer.id, role: 'viewer', grantedById: owner.id },
        ],
      });
    }

    return { transcriptId: transcript.id, speakerId: speaker.id, segmentId: segment.id };
  }

  /**
   * What the ACCESS GATE said: `404`, `403`, or `null` for "admitted".
   *
   * ⚠ A `ConflictException` COUNTS AS ADMITTED, deliberately. Every access
   * check in this codebase runs before any state check, so a 409 — "version 1
   * has no snapshot to rebuild from yet", "this transcript is at version 2" —
   * is proof the caller got THROUGH the gate and was then stopped by the state
   * of the row. Folding it into `null` keeps this matrix about authorisation
   * and leaves the state rules to `transcript-corrections.db.spec.ts`, which
   * owns them. It cannot mask a denial: a denial is thrown first, so a refused
   * caller never reaches the code that raises a conflict.
   */
  async function statusOf(action: () => Promise<unknown>): Promise<number | null> {
    try {
      await action();

      return null;
    } catch (error) {
      if (error instanceof NotFoundException) return 404;
      if (error instanceof ForbiddenException) return 403;
      if (error instanceof ConflictException) return null;

      throw error;
    }
  }

  // ===========================================================================
  // THE MATRIX
  // ===========================================================================

  describe('the RBAC matrix', () => {
    /**
     * The eight capabilities of issue #29's acceptance list, each run through
     * the REAL service that implements it rather than through a restatement of
     * the rule.
     *
     * ⚠ `export` IS RUN AS THE `view` GATE, on purpose. Issue #28 owns the
     * exporters and they are not on this branch; what issue #29 promises about
     * export is that it is reachable at exactly the level reading is, so that
     * is what is asserted — against the same `TranscriptAccessService.require`
     * call every exporter will make. When #28 lands, its own suite covers the
     * formats; this row keeps the access rule from drifting in the meantime.
     */
    function capabilities(seedRow: Seed) {
      return {
        read: (user: RequestUser) => transcripts.detail(seedRow.transcriptId, user),
        play: (user: RequestUser) => transcripts.audio(seedRow.transcriptId, user),
        export: (user: RequestUser) =>
          access.require(user.id, seedRow.transcriptId, 'view', user.permissions),
        edit: (user: RequestUser) =>
          editing.applyOperations(
            seedRow.transcriptId,
            {
              baseVersion: 1,
              // A FRESH batch id per call: the same one twice is an
              // idempotent replay by design, which would make a second actor's
              // attempt silently "succeed" without touching the access check.
              clientBatchId: randomUUID(),
              ops: [
                {
                  op: 'segment.update_text',
                  segmentId: seedRow.segmentId,
                  rev: 1,
                  text: 'one two four',
                },
              ],
            } as never,
            user,
          ),
        // `baseVersion` is read fresh, because a restore (unlike a correction
        // batch) demands it EQUAL the current version — and the `edit` row
        // above has usually just moved it. The access check is what this row
        // is about; a 409 from a stale number would prove nothing either way.
        restore: async (user: RequestUser) => {
          const row = await prisma.transcript.findUniqueOrThrow({
            where: { id: seedRow.transcriptId },
            select: { currentVersion: true },
          });

          return editing.restore(
            seedRow.transcriptId,
            1,
            { baseVersion: row.currentVersion } as never,
            user,
          );
        },
        share: (user: RequestUser) =>
          sharing.add(
            seedRow.transcriptId,
            { email: stranger.email, role: 'viewer' },
            user,
          ),
        listShares: (user: RequestUser) => sharing.list(seedRow.transcriptId, user),
        delete: (user: RequestUser) => transcripts.remove(seedRow.transcriptId, user),
        leave: (user: RequestUser) => sharing.remove(seedRow.transcriptId, user.id, user),
      };
    }

    it('OWNER can do everything, including share and delete', async () => {
      const seeded = await seed();
      const can = capabilities(seeded);

      expect(await statusOf(() => can.read(owner))).toBeNull();
      expect(await statusOf(() => can.play(owner))).toBeNull();
      expect(await statusOf(() => can.export(owner))).toBeNull();
      expect(await statusOf(() => can.edit(owner))).toBeNull();
      expect(await statusOf(() => can.share(owner))).toBeNull();
      expect(await statusOf(() => can.listShares(owner))).toBeNull();
      // Restore last among the writes, since edit moved the version on.
      expect(await statusOf(() => can.restore(owner))).toBeNull();
      expect(await statusOf(() => can.delete(owner))).toBeNull();
    });

    it('EDITOR can read, play, export and edit — but not share, delete or list shares', async () => {
      const seeded = await seed();
      const can = capabilities(seeded);

      expect(await statusOf(() => can.read(editor))).toBeNull();
      expect(await statusOf(() => can.play(editor))).toBeNull();
      expect(await statusOf(() => can.export(editor))).toBeNull();
      expect(await statusOf(() => can.edit(editor))).toBeNull();

      // 404 and not 403 for all three: the fact that a share list exists, and
      // the fact that only the owner may delete, are not things a lesser share
      // holder gets to have confirmed.
      expect(await statusOf(() => can.share(editor))).toBe(404);
      expect(await statusOf(() => can.listShares(editor))).toBe(404);
      expect(await statusOf(() => can.delete(editor))).toBe(404);
    });

    it('VIEWER can read, play and export — but not edit, restore, share or delete', async () => {
      const seeded = await seed();
      const can = capabilities(seeded);

      expect(await statusOf(() => can.read(viewer))).toBeNull();
      expect(await statusOf(() => can.play(viewer))).toBeNull();
      expect(await statusOf(() => can.export(viewer))).toBeNull();

      expect(await statusOf(() => can.edit(viewer))).toBe(404);
      expect(await statusOf(() => can.restore(viewer))).toBe(404);
      expect(await statusOf(() => can.share(viewer))).toBe(404);
      expect(await statusOf(() => can.listShares(viewer))).toBe(404);
      expect(await statusOf(() => can.delete(viewer))).toBe(404);
    });

    it('STRANGER gets 404 for EVERY capability, never 403', async () => {
      const seeded = await seed();
      const can = capabilities(seeded);

      for (const [name, capability] of Object.entries(can)) {
        const status = await statusOf(() => capability(stranger));

        // The whole point of §6.1: 403 would confirm the id exists.
        expect({ [name]: status }).toEqual({ [name]: 404 });
      }
    });

    it('gives the stranger the SAME message for a real transcript and an invented id', async () => {
      const seeded = await seed();

      const real = await access
        .require(stranger.id, seeded.transcriptId, 'view', stranger.permissions)
        .catch((error: Error) => error.message);
      const invented = await access
        .require(stranger.id, randomUUID(), 'view', stranger.permissions)
        .catch((error: Error) => error.message);

      expect(real).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(invented).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });

    it('an EDITOR share cannot supply `transcripts:write` the caller\'s roles withhold', async () => {
      const seeded = await seed();
      const readOnlyEditor = actor(editor.id, editor.email, ['transcripts:read']);

      // Reading is fine — the share grants it.
      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, readOnlyEditor))).toBeNull();

      // Editing is 403, NOT 404: they can already see the transcript, so there
      // is nothing left to conceal, and a 404 would tell them their own
      // transcript had vanished (spec §6.1's note on the failure mode).
      expect(
        await statusOf(() =>
          access.require(readOnlyEditor.id, seeded.transcriptId, 'edit', readOnlyEditor.permissions),
        ),
      ).toBe(403);
    });

    it('lets a RECIPIENT leave, and a leave is not a revoke of anybody else', async () => {
      const seeded = await seed();

      await sharing.remove(seeded.transcriptId, viewer.id, viewer);

      // The viewer is gone; the editor is untouched.
      expect(
        await prisma.transcriptShare.findMany({ where: { transcriptId: seeded.transcriptId } }),
      ).toHaveLength(1);

      // And a viewer cannot remove the editor on their way out.
      expect(
        await statusOf(() => sharing.remove(seeded.transcriptId, editor.id, viewer)),
      ).toBe(404);
    });
  });

  // ===========================================================================
  // IMMEDIACY — the claim a mock cannot make
  // ===========================================================================

  describe('revocation and role changes take effect on the next request', () => {
    it('a revoked share loses access IMMEDIATELY — the very next call is 404', async () => {
      const seeded = await seed();

      // Before: the viewer can read it.
      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, viewer))).toBeNull();

      await sharing.remove(seeded.transcriptId, viewer.id, owner);

      // After: the NEXT call, with no restart, no re-login and no token
      // refresh in between, is already refused. Nothing was invalidated,
      // because there is nothing anywhere that holds a grant.
      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, viewer))).toBe(404);
    });

    it('a promotion takes effect immediately — an edit refused a moment ago succeeds', async () => {
      const seeded = await seed();

      expect(
        await statusOf(() => access.require(viewer.id, seeded.transcriptId, 'edit', viewer.permissions)),
      ).toBe(404);

      await sharing.update(seeded.transcriptId, viewer.id, { role: 'editor' }, owner);

      expect(
        await statusOf(() => access.require(viewer.id, seeded.transcriptId, 'edit', viewer.permissions)),
      ).toBeNull();
    });

    it('a demotion takes effect immediately — an edit allowed a moment ago is refused', async () => {
      const seeded = await seed();

      expect(
        await statusOf(() => access.require(editor.id, seeded.transcriptId, 'edit', editor.permissions)),
      ).toBeNull();

      await sharing.update(seeded.transcriptId, editor.id, { role: 'viewer' }, owner);

      expect(
        await statusOf(() => access.require(editor.id, seeded.transcriptId, 'edit', editor.permissions)),
      ).toBe(404);

      // Reading still works — a demotion is not a revocation.
      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, editor))).toBeNull();
    });

    it('a deleted transcript is 404 for its own recipients on the next call', async () => {
      const seeded = await seed();

      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, editor))).toBeNull();

      await transcripts.remove(seeded.transcriptId, owner);

      expect(await statusOf(() => transcripts.detail(seeded.transcriptId, editor))).toBe(404);
    });
  });

  // ===========================================================================
  // THE ROW ITSELF
  // ===========================================================================

  describe('the share row', () => {
    it('re-shares by UPDATING one row rather than creating a competing second', async () => {
      const seeded = await seed({ shares: false });

      await sharing.add(seeded.transcriptId, { email: viewer.email, role: 'viewer' }, owner);
      await sharing.add(seeded.transcriptId, { email: viewer.email, role: 'editor' }, owner);

      const rows = await prisma.transcriptShare.findMany({
        where: { transcriptId: seeded.transcriptId, userId: viewer.id },
      });

      // `@@unique([transcriptId, userId])` makes two competing rows
      // unrepresentable; the upsert is what turns that into an update.
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('editor');
    });

    it('refuses a second row for the same pair at the DATABASE level', async () => {
      const seeded = await seed();

      await expect(
        prisma.transcriptShare.create({
          data: {
            transcriptId: seeded.transcriptId,
            userId: editor.id,
            role: 'viewer',
            grantedById: owner.id,
          },
        }),
      ).rejects.toMatchObject({ code: 'P2002' });
    });

    it('finds a recipient by a DIFFERENTLY-CASED address', async () => {
      const seeded = await seed({ shares: false });

      const share = await sharing.add(
        seeded.transcriptId,
        { email: viewer.email.toUpperCase(), role: 'viewer' },
        owner,
      );

      expect(share.userId).toBe(viewer.id);
    });

    it('answers an INACTIVE account exactly as it answers an absent one', async () => {
      const seeded = await seed({ shares: false });

      const forInactive = await sharing
        .add(seeded.transcriptId, { email: inactive.email, role: 'viewer' }, owner)
        .catch((error: Error) => error.message);
      const forAbsent = await sharing
        .add(seeded.transcriptId, { email: `${EMAIL_PREFIX}-ghost@example.test`, role: 'viewer' }, owner)
        .catch((error: Error) => error.message);

      expect(forInactive).toBe(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      expect(forAbsent).toBe(SHARE_RECIPIENT_NOT_FOUND_MESSAGE);
      expect(
        await prisma.transcriptShare.count({ where: { transcriptId: seeded.transcriptId } }),
      ).toBe(0);
    });

    it('cascades away with the transcript, leaving no orphan grants', async () => {
      const seeded = await seed();

      await prisma.transcriptVersion.deleteMany({ where: { transcriptId: seeded.transcriptId } });
      await prisma.transcriptSegment.deleteMany({ where: { transcriptId: seeded.transcriptId } });
      await prisma.transcriptSpeaker.deleteMany({ where: { transcriptId: seeded.transcriptId } });
      await prisma.transcript.delete({ where: { id: seeded.transcriptId } });

      expect(
        await prisma.transcriptShare.count({ where: { transcriptId: seeded.transcriptId } }),
      ).toBe(0);
    });
  });

  // ===========================================================================
  // THE NOTIFICATION AND THE AUDIT TRAIL
  // ===========================================================================

  describe('notifications and audit', () => {
    it('notifies the RECIPIENT and nobody else', async () => {
      const seeded = await seed({ shares: false });

      await sharing.add(seeded.transcriptId, { email: editor.email, role: 'editor' }, owner);

      expect(notify).toHaveBeenCalledTimes(1);

      const [eventKey, addressedTo, payload] = notify.mock.calls[0];

      expect(eventKey).toBe('transcripts.transcript_shared');
      expect(addressedTo).toBe(editor.id);
      expect(payload).toMatchObject({
        transcriptId: seeded.transcriptId,
        role: 'editor',
        // The OWNER's display name, read from the real row.
        ownerName: 'The owner',
      });

      // Not the owner, not the viewer, not anybody else.
      const addressees = notify.mock.calls.map((call) => call[1]);

      expect(addressees).toEqual([editor.id]);
      expect(addressees).not.toContain(owner.id);
      expect(addressees).not.toContain(viewer.id);
    });

    it('says nothing at all on a revoke', async () => {
      const seeded = await seed();

      await sharing.remove(seeded.transcriptId, viewer.id, owner);

      expect(notify).not.toHaveBeenCalled();
    });

    it('writes one audit row per grant, update and revoke', async () => {
      const seeded = await seed({ shares: false });

      await sharing.add(seeded.transcriptId, { email: viewer.email, role: 'viewer' }, owner);
      await sharing.update(seeded.transcriptId, viewer.id, { role: 'editor' }, owner);
      await sharing.remove(seeded.transcriptId, viewer.id, owner);

      const rows = await prisma.auditEvent.findMany({
        where: { targetType: 'transcript', targetId: seeded.transcriptId },
        orderBy: { createdAt: 'asc' },
      });

      expect(rows.map((row) => row.action)).toEqual([
        'transcript:share:grant',
        'transcript:share:update',
        'transcript:share:revoke',
      ]);
      expect(rows.every((row) => row.actorUserId === owner.id)).toBe(true);
    });

    it('records a LEAVE as a revoke performed by the person leaving', async () => {
      const seeded = await seed();

      await sharing.remove(seeded.transcriptId, viewer.id, viewer);

      const row = await prisma.auditEvent.findFirst({
        where: { targetType: 'transcript', targetId: seeded.transcriptId },
        orderBy: { createdAt: 'desc' },
      });

      expect(row?.action).toBe('transcript:share:revoke');
      expect(row?.actorUserId).toBe(viewer.id);
      expect(row?.meta).toMatchObject({ left: true });
    });
  });

  // ===========================================================================
  // WHAT THE LIST SURFACES SAY ABOUT A SHARED ROW
  // ===========================================================================

  describe('listing and the home page', () => {
    it('reports the OWNER\'s display name and the CALLER\'s role on `scope=shared`', async () => {
      const seeded = await seed();

      const page = await transcripts.list(
        { scope: 'shared', limit: 20 } as never,
        editor.id,
      );

      const row = page.items.find((item) => item.id === seeded.transcriptId);

      expect(row).toMatchObject({ access: 'editor', ownerName: 'The owner' });
    });

    it('reports the same pair in the `sharedWithMe` block of the summary', async () => {
      const seeded = await seed();

      const summary = await transcripts.summary(viewer.id);
      const row = summary.sharedWithMe.find((item) => item.id === seeded.transcriptId);

      expect(row).toMatchObject({ access: 'viewer', ownerName: 'The owner' });
      // And it is NOT in their "recent", which is owned rows only.
      expect(summary.recent.map((item) => item.id)).not.toContain(seeded.transcriptId);
      expect(summary.counts.shared).toBeGreaterThan(0);
    });

    // Issue #171 (epic #166): the summary's `failed` list is OWNER-SCOPED,
    // unlike `inProgress`, which unions the caller's shares. Retry is
    // owner-only, so a failure on somebody else's recording is an item this
    // caller could not act on — and a "Needs attention" section is a promise
    // that every row in it is theirs to fix. Proved here rather than against a
    // mock because it is a claim about which ROWS two real queries return for
    // two real users over one real `transcript_shares` row.
    it('keeps a SHARED failed transcript out of the viewer\'s `failed` list (#171)', async () => {
      const seeded = await seed();

      await prisma.transcript.update({
        where: { id: seeded.transcriptId },
        data: {
          status: 'failed',
          transcriptionStatus: 'failed',
          failureReason: 'The provider gave up.',
        },
      });

      const [forViewer, forOwner] = await Promise.all([
        transcripts.summary(viewer.id),
        transcripts.summary(owner.id),
      ]);

      // The share is real — it is in `sharedWithMe` — so its absence from
      // `failed` is the scope rule, not an empty fixture.
      expect(forViewer.sharedWithMe.map((item) => item.id)).toContain(seeded.transcriptId);
      expect(forViewer.failed.map((item) => item.id)).not.toContain(seeded.transcriptId);
      expect(forViewer.counts.failed).toBe(0);

      // And it IS in the owner's own list, newest first.
      expect(forOwner.failed.map((item) => item.id)).toContain(seeded.transcriptId);
      expect(forOwner.counts.failed).toBeGreaterThan(0);
    });

    it('drops a shared row from the list the moment the share is revoked', async () => {
      const seeded = await seed();

      await sharing.remove(seeded.transcriptId, viewer.id, owner);

      const page = await transcripts.list({ scope: 'shared', limit: 20 } as never, viewer.id);

      expect(page.items.map((item) => item.id)).not.toContain(seeded.transcriptId);
    });
  });
});
