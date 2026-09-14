import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from './transcript-access.service';

// =============================================================================
// TranscriptAccessService — 404 is the whole point (issue #25, spec §6.1)
// =============================================================================
//
// The assertion this file exists for is the one about the STATUS CODE. A 403
// confirms that transcript `abc123` exists and merely refuses the caller; a
// 404 reveals nothing either way, which is the only answer compatible with
// treating a transcript as a private conversation. Every no-access case below
// checks the code AND the message, because two differently-worded 404s would
// reintroduce exactly the oracle the code was chosen to remove.
// =============================================================================

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const EDITOR = 'user-editor';
const VIEWER = 'user-viewer';
const ID = 'transcript-1';

const transcript = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  ownerId: OWNER,
  deletedAt: null,
  ...overrides,
});

describe('TranscriptAccessService', () => {
  let service: TranscriptAccessService;
  let prisma: {
    transcript: { findUnique: jest.Mock };
    transcriptShare: { findUnique: jest.Mock };
  };

  beforeEach(async () => {
    prisma = {
      transcript: { findUnique: jest.fn() },
      transcriptShare: { findUnique: jest.fn() },
    };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptAccessService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(TranscriptAccessService);
  });

  describe('the owner', () => {
    it('satisfies view', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript());

      const access = await service.require(OWNER, ID, 'view');

      expect(access.role).toBe('owner');
    });

    it('satisfies edit and own, given `transcripts:write`', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript());

      await expect(
        service.require(OWNER, ID, 'edit', ['transcripts:write']),
      ).resolves.toMatchObject({ role: 'owner' });
      await expect(
        service.require(OWNER, ID, 'own', ['transcripts:write']),
      ).resolves.toMatchObject({ role: 'owner' });
    });

    it('is refused edit WITHOUT `transcripts:write` — and told so, with a 403', async () => {
      // The one place a 403 is right: the caller can already SEE the row, so
      // there is nothing left to conceal, and a 404 would tell them their own
      // transcript had vanished.
      prisma.transcript.findUnique.mockResolvedValue(transcript());

      await expect(service.require(OWNER, ID, 'edit', [])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('a caller with no access', () => {
    it('gets 404, not 403, for a transcript that exists', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue(null);

      await expect(service.require(STRANGER, ID, 'view')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('gets the SAME message for a transcript that does not exist', async () => {
      // Byte-identical answers for "absent" and "forbidden". If these two ever
      // diverge, the status code stops meaning anything.
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue(null);

      const forbidden = await service
        .require(STRANGER, ID, 'view')
        .catch((error: Error) => error.message);

      prisma.transcript.findUnique.mockResolvedValue(null);

      const absent = await service
        .require(STRANGER, ID, 'view')
        .catch((error: Error) => error.message);

      expect(forbidden).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(absent).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });

    it('never even looks for a share when the row is soft-deleted', async () => {
      prisma.transcript.findUnique.mockResolvedValue(
        transcript({ deletedAt: new Date() }),
      );

      await expect(service.require(OWNER, ID, 'view')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.transcriptShare.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('shares', () => {
    it('an editor share satisfies view and edit', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'editor' });

      await expect(service.require(EDITOR, ID, 'view')).resolves.toMatchObject({
        role: 'editor',
      });
      await expect(
        service.require(EDITOR, ID, 'edit', ['transcripts:write']),
      ).resolves.toMatchObject({ role: 'editor' });
    });

    it('an editor share does NOT satisfy own — the owner alone may delete', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'editor' });

      await expect(
        service.require(EDITOR, ID, 'own', ['transcripts:write']),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a viewer share satisfies view only, and edit is a 404 not a 403', async () => {
      // The ROLE of a share is not something a holder of a lesser one gets to
      // enumerate, so the refusal says nothing about what they hold.
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'viewer' });

      await expect(service.require(VIEWER, ID, 'view')).resolves.toMatchObject({
        role: 'viewer',
      });
      await expect(
        service.require(VIEWER, ID, 'edit', ['transcripts:write']),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an editor share cannot substitute for `transcripts:write`', async () => {
      // A share caps the CEILING an RBAC permission can raise a user to; it
      // never raises the floor.
      prisma.transcript.findUnique.mockResolvedValue(transcript());
      prisma.transcriptShare.findUnique.mockResolvedValue({ role: 'editor' });

      await expect(service.require(EDITOR, ID, 'edit', [])).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });
  });

  describe('roleFor', () => {
    it('reports owner without querying shares', async () => {
      const role = await service.roleFor(OWNER, transcript() as never);

      expect(role).toBe('owner');
      expect(prisma.transcriptShare.findUnique).not.toHaveBeenCalled();
    });

    it('reports null rather than throwing, for the list surfaces', async () => {
      prisma.transcriptShare.findUnique.mockResolvedValue(null);

      await expect(service.roleFor(STRANGER, transcript() as never)).resolves.toBeNull();
    });
  });
});
