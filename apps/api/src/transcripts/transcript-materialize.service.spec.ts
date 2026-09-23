// =============================================================================
// TranscriptMaterializeService — the speaker-identities overlay (issue #323)
// =============================================================================
//
// `materialize()` is otherwise covered by the real-database property test in
// `test/transcripts/transcript-corrections.db.spec.ts` (spec §4.4's
// `materialize(currentVersion) == live` invariant needs a real transaction to
// mean anything). What is unit-testable, and worth pinning here, is the one
// thing #323 added on top of replay: the identities map is overlaid ONCE, at
// the outermost return, onto whatever replay produced — never baked into a
// snapshot, never re-applied inside a restore chain's inner hops.
//
// The two cases this file exists to prove:
//
//   • an OLDER version, rebuilt from a snapshot plus replay, still shows an
//     identified name, because the overlay uses the identities map as it
//     stands NOW and applies to every version, not just the current one;
//   • a speaker a VERSIONED op renamed keeps that name — the overlay only
//     touches a speaker still carrying its ingest placeholder, so a real
//     correction recorded in the log outranks the entry beside it.
// =============================================================================

import { gzipSync } from 'node:zlib';

import { segment, speaker } from './editing/__fixtures__/state';
import { OP_TYPES } from './editing/ops';
import type { PrismaService } from '../prisma/prisma.service';
import {
  SNAPSHOT_FORMAT_VERSION,
  TranscriptMaterializeService,
  type SnapshotPayload,
} from './transcript-materialize.service';
import type { TranscriptObjectsService } from './transcript-objects.service';

const TRANSCRIPT_ID = 'transcript-1';
// `recordedOpSchema` (parsed back out of the version log) requires a UUID —
// unlike the reducer fixtures, which never go through that schema.
const SPEAKER_A = '11111111-1111-4111-8111-111111111111';

function snapshotBuffer(payload: SnapshotPayload): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(payload), 'utf8'));
}

/** A one-chunk "stream" — `for await` accepts a plain array just as well. */
function streamOf(buffer: Buffer) {
  return [buffer];
}

function build() {
  const prisma = {
    transcript: { findUnique: jest.fn() },
    transcriptVersion: { findFirst: jest.fn(), findMany: jest.fn() },
  };

  const objects = { download: jest.fn() };

  const service = new TranscriptMaterializeService(
    prisma as unknown as PrismaService,
    objects as unknown as TranscriptObjectsService,
  );

  return { service, prisma, objects };
}

describe('materialize() overlays speaker identities (#323)', () => {
  it('shows the identified name on an OLDER version rebuilt from a snapshot', async () => {
    const { service, prisma, objects } = build();

    // The transcript is at v5 today, with "Speaker A" identified as "Oscar" —
    // an unversioned write that never touched the snapshot below.
    prisma.transcript.findUnique.mockResolvedValue({
      id: TRANSCRIPT_ID,
      currentVersion: 5,
      deletedAt: null,
      speakerIdentities: { [SPEAKER_A]: 'Oscar' },
    });

    // A v1 snapshot, taken before anybody named the speaker: it genuinely
    // says "Speaker A", exactly as ingest wrote it.
    const snapshotPayload: SnapshotPayload = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      transcriptId: TRANSCRIPT_ID,
      version: 1,
      speakers: [speaker(SPEAKER_A, 'Speaker A', { label: 'A' })],
      segments: [segment('s1', SPEAKER_A, 'hello there')],
    };

    objects.download.mockResolvedValue(streamOf(snapshotBuffer(snapshotPayload)));

    prisma.transcriptVersion.findFirst.mockImplementation(
      async (args: { where: { kind?: string } }) => {
        if (args.where.kind === 'restore') return null;

        return { version: 1, snapshotObjectId: 'snap-1' };
      },
    );

    // Version 2's own history did nothing to this speaker.
    prisma.transcriptVersion.findMany.mockResolvedValue([{ version: 2, ops: [] }]);

    const { state } = await service.materialize(TRANSCRIPT_ID, 2);

    expect(state.speakers.find((row) => row.id === SPEAKER_A)?.displayName).toBe('Oscar');
  });

  it('keeps a VERSIONED rename — the overlay never overrides a real correction', async () => {
    const { service, prisma, objects } = build();

    prisma.transcript.findUnique.mockResolvedValue({
      id: TRANSCRIPT_ID,
      currentVersion: 5,
      deletedAt: null,
      // The map still names "A" — as it would right up until a LATER
      // versioned rename puts it back on the placeholder and retires the
      // entry (`retireIdentities`, in the editing service). Here it has not
      // been retired, and the overlay must still lose to the version log.
      speakerIdentities: { [SPEAKER_A]: 'Oscar' },
    });

    const snapshotPayload: SnapshotPayload = {
      formatVersion: SNAPSHOT_FORMAT_VERSION,
      transcriptId: TRANSCRIPT_ID,
      version: 1,
      speakers: [speaker(SPEAKER_A, 'Speaker A', { label: 'A' })],
      segments: [segment('s1', SPEAKER_A, 'hello there')],
    };

    objects.download.mockResolvedValue(streamOf(snapshotBuffer(snapshotPayload)));

    prisma.transcriptVersion.findFirst.mockImplementation(
      async (args: { where: { kind?: string } }) => {
        if (args.where.kind === 'restore') return null;

        return { version: 1, snapshotObjectId: 'snap-1' };
      },
    );

    // Version 2 is a genuine, versioned correction of the same speaker.
    prisma.transcriptVersion.findMany.mockResolvedValue([
      {
        version: 2,
        ops: [{ op: OP_TYPES.RENAME_SPEAKER, speakerId: SPEAKER_A, rev: 1, displayName: 'Renamed' }],
      },
    ]);

    const { state } = await service.materialize(TRANSCRIPT_ID, 2);

    // Not "Oscar": the speaker is no longer carrying its placeholder, so
    // `applyIdentities` leaves it alone.
    expect(state.speakers.find((row) => row.id === SPEAKER_A)?.displayName).toBe('Renamed');
  });
});
