import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AccessPolicy } from '@marinoscar/platform-api/sharing';

import { PrismaService } from '../prisma/prisma.service';
import {
  TRANSCRIPT_NOT_FOUND_MESSAGE,
  TranscriptAccessService,
} from './transcript-access.service';

// =============================================================================
// TranscriptAccessService — 404 is the whole point (issue #25, spec §6.1; #485)
// =============================================================================
//
// The decision is the platform's `AccessPolicy` since #485 (its own matrix is
// tested in the package, and the real thing runs in
// `test/transcripts/transcript-sharing.db.spec.ts`). What is asserted HERE is what
// this service adds on top of it:
//
//   * the level -> action mapping (`view` -> read, `edit` -> write, `own` -> delete),
//   * ONE shared 404 body, byte-identical for "absent" and "not yours" (the
//     platform's own refusal says "Resource not found" and never gets through),
//   * the 403 naming `transcripts:write` ONLY for a caller who can already see the
//     row at the level asked for. The platform checks the permission before the
//     role, so without this a stranger would be told "missing permission" and learn
//     the transcript exists.
// =============================================================================

const OWNER = 'user-owner';
const STRANGER = 'user-stranger';
const EDITOR = 'user-editor';
const VIEWER = 'user-viewer';
const ID = 'transcript-1';
const ORG = 'org-1';

const transcript = (overrides: Record<string, unknown> = {}) => ({
  id: ID,
  ownerId: OWNER,
  orgId: ORG,
  deletedAt: null,
  ...overrides,
});

const allowed = (role: string) => ({ allowed: true, role, via: role === 'owner' ? 'owner' : 'user_grant' });
const denied = (role: string | null = null) => ({ allowed: false, role, via: null });
const needsWrite = (role: string | null) => ({
  allowed: false,
  role,
  via: null,
  missingPermission: 'transcripts:write',
});

describe('TranscriptAccessService', () => {
  let service: TranscriptAccessService;
  let prisma: { transcript: { findUnique: jest.Mock } };
  let policy: { decide: jest.Mock; roleFor: jest.Mock; decideMany: jest.Mock };

  beforeEach(async () => {
    prisma = { transcript: { findUnique: jest.fn().mockResolvedValue(transcript()) } };
    policy = { decide: jest.fn(), roleFor: jest.fn(), decideMany: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        TranscriptAccessService,
        { provide: PrismaService, useValue: prisma },
        { provide: AccessPolicy, useValue: policy },
      ],
    }).compile();

    service = module.get(TranscriptAccessService);
  });

  describe('the level -> action mapping', () => {
    it.each([
      ['view', 'read'],
      ['edit', 'write'],
      ['own', 'delete'],
    ] as const)('asks the policy for `%s` as `%s`, in the transcript\'s organization', async (level, action) => {
      policy.decide.mockResolvedValue(allowed('owner'));

      await service.require(OWNER, ID, level, ['transcripts:write']);

      expect(policy.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: OWNER,
          activeOrgId: ORG,
          permissions: ['transcripts:write'],
        }),
        action,
        { type: 'transcript', id: ID },
      );
    });
  });

  describe('the owner', () => {
    it('satisfies view, edit and own, given `transcripts:write`', async () => {
      policy.decide.mockResolvedValue(allowed('owner'));

      await expect(service.require(OWNER, ID, 'view')).resolves.toMatchObject({ role: 'owner' });
      await expect(service.require(OWNER, ID, 'edit', ['transcripts:write'])).resolves.toMatchObject({
        role: 'owner',
      });
      await expect(service.require(OWNER, ID, 'own', ['transcripts:write'])).resolves.toMatchObject({
        role: 'owner',
      });
    });

    it('is refused edit WITHOUT `transcripts:write` — and told so, with a 403', async () => {
      // The one place a 403 is right: the caller can already SEE the row, so
      // there is nothing left to conceal, and a 404 would tell them their own
      // transcript had vanished.
      policy.decide.mockResolvedValue(needsWrite('owner'));

      const error = await service.require(OWNER, ID, 'edit', []).catch((e: Error) => e);

      expect(error).toBeInstanceOf(ForbiddenException);
      expect((error as Error).message).toContain('transcripts:write');
    });
  });

  describe('a caller with no access', () => {
    it('gets 404, not 403, for a transcript that exists', async () => {
      policy.decide.mockResolvedValue(denied());

      await expect(service.require(STRANGER, ID, 'view')).rejects.toBeInstanceOf(NotFoundException);
    });

    it('gets the SAME message for a transcript that does not exist', async () => {
      // Byte-identical answers for "absent" and "forbidden". If these two ever
      // diverge, the status code stops meaning anything.
      policy.decide.mockResolvedValue(denied());

      const forbidden = await service.require(STRANGER, ID, 'view').catch((e: Error) => e.message);

      prisma.transcript.findUnique.mockResolvedValue(null);

      const absent = await service.require(STRANGER, ID, 'view').catch((e: Error) => e.message);

      expect(forbidden).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
      expect(absent).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });

    it('a stranger WITHOUT `transcripts:write` still gets the 404, never the 403 that names the permission', async () => {
      // The platform answers a missing permission before it looks at the role.
      policy.decide.mockResolvedValue(needsWrite(null));

      const error = await service.require(STRANGER, ID, 'edit', []).catch((e: Error) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as Error).message).toBe(TRANSCRIPT_NOT_FOUND_MESSAGE);
    });

    it('never asks the policy when the row is soft-deleted', async () => {
      prisma.transcript.findUnique.mockResolvedValue(transcript({ deletedAt: new Date() }));

      await expect(service.require(OWNER, ID, 'view')).rejects.toBeInstanceOf(NotFoundException);
      expect(policy.decide).not.toHaveBeenCalled();
    });
  });

  describe('shares', () => {
    it('an editor share satisfies view and edit', async () => {
      policy.decide.mockResolvedValue(allowed('editor'));

      await expect(service.require(EDITOR, ID, 'view')).resolves.toMatchObject({ role: 'editor' });
      await expect(service.require(EDITOR, ID, 'edit', ['transcripts:write'])).resolves.toMatchObject({
        role: 'editor',
      });
    });

    it('an editor share does NOT satisfy own — the owner alone may delete', async () => {
      policy.decide.mockResolvedValue(denied('editor'));

      await expect(service.require(EDITOR, ID, 'own', ['transcripts:write'])).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('an editor without `transcripts:write` asking to delete gets the 404 (cannot own), not the 403', async () => {
      policy.decide.mockResolvedValue(needsWrite('editor'));

      await expect(service.require(EDITOR, ID, 'own', [])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('a viewer share satisfies view only, and edit is a 404 not a 403', async () => {
      // The ROLE of a share is not something a holder of a lesser one gets to
      // enumerate, so the refusal says nothing about what they hold. This holds
      // for a viewer WITHOUT the permission too: the platform's missing-permission
      // answer would otherwise turn it into a 403.
      policy.decide.mockImplementation(async (_principal, action: string) =>
        action === 'read' ? allowed('viewer') : denied('viewer'),
      );

      await expect(service.require(VIEWER, ID, 'view')).resolves.toMatchObject({ role: 'viewer' });
      await expect(service.require(VIEWER, ID, 'edit', ['transcripts:write'])).rejects.toBeInstanceOf(
        NotFoundException,
      );

      policy.decide.mockResolvedValue(needsWrite('viewer'));

      await expect(service.require(VIEWER, ID, 'edit', [])).rejects.toBeInstanceOf(NotFoundException);
    });

    it('an editor share cannot substitute for `transcripts:write`', async () => {
      // A share caps the CEILING an RBAC permission can raise a user to; it
      // never raises the floor.
      policy.decide.mockResolvedValue(needsWrite('editor'));

      await expect(service.require(EDITOR, ID, 'edit', [])).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('roleFor', () => {
    it('reports owner without asking the policy', async () => {
      const role = await service.roleFor(OWNER, transcript() as never);

      expect(role).toBe('owner');
      expect(policy.roleFor).not.toHaveBeenCalled();
    });

    it('reports the shared role, and null rather than throwing, for the list surfaces', async () => {
      policy.roleFor.mockResolvedValueOnce('editor').mockResolvedValueOnce(null);

      await expect(service.roleFor(EDITOR, transcript() as never)).resolves.toBe('editor');
      await expect(service.roleFor(STRANGER, transcript() as never)).resolves.toBeNull();
    });
  });

  describe('rolesFor', () => {
    it('decides a whole page in one batched call, owners without asking', async () => {
      policy.decideMany.mockResolvedValue(
        new Map<string, unknown>([
          ['transcript:t-shared', allowed('viewer')],
          ['transcript:t-hidden', denied()],
        ]),
      );

      const roles = await service.rolesFor(VIEWER, [
        { id: 't-own', ownerId: VIEWER, orgId: ORG },
        { id: 't-shared', ownerId: OWNER, orgId: ORG },
        { id: 't-hidden', ownerId: OWNER, orgId: ORG },
      ]);

      expect(policy.decideMany).toHaveBeenCalledTimes(1);
      expect(Object.fromEntries(roles)).toEqual({ 't-own': 'owner', 't-shared': 'viewer' });
    });
  });
});
