import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PERMISSIONS } from '../../common/constants/roles.constants';
import { PrismaService } from '../../prisma/prisma.service';
import { NOTE_NOT_FOUND_MESSAGE, NoteAccessService } from './note-access.service';

// =============================================================================
// NoteAccessService (issue #53, epic #45)
// =============================================================================
//
// The three properties this service exists to hold, each asserted directly:
//
//   1. EVERY refusal that is about EXISTENCE is a 404 with the SAME message.
//      Missing, somebody else's, and soft-deleted are indistinguishable from
//      outside — which is the whole point (spec §6.1).
//   2. The one refusal that is NOT about existence — an owner who lacks
//      `notes:write` — is a 403. They can already see the note, so there is
//      nothing left to conceal and a 404 would tell them their own note had
//      vanished.
//   3. It RETURNS the row, so no caller ever has a reason to query `notes`
//      itself. That is what makes "look it up, then authorise" impossible to
//      write by accident.
// =============================================================================

const NOTE_ID = 'note-1';
const OWNER = 'user-1';

describe('NoteAccessService', () => {
  let service: NoteAccessService;
  let prisma: { note: { findUnique: jest.Mock } };

  const note = (overrides: Record<string, unknown> = {}) => ({
    id: NOTE_ID,
    ownerId: OWNER,
    deletedAt: null,
    title: 'Kestrel weekly',
    ...overrides,
  });

  beforeEach(async () => {
    prisma = { note: { findUnique: jest.fn() } };

    const module = await Test.createTestingModule({
      providers: [NoteAccessService, { provide: PrismaService, useValue: prisma }],
    }).compile();

    service = module.get(NoteAccessService);
  });

  it('returns the row, so nothing above it needs to query `notes`', async () => {
    prisma.note.findUnique.mockResolvedValue(note());

    const access = await service.require(OWNER, NOTE_ID, 'view');

    expect(access.note.id).toBe(NOTE_ID);
    expect(access.role).toBe('owner');
  });

  it.each([
    ['a note that does not exist', null],
    ['another user\'s note', { ownerId: 'somebody-else' }],
    ['a soft-deleted note', { deletedAt: new Date() }],
  ])('answers the same 404 for %s', async (_label, overrides) => {
    prisma.note.findUnique.mockResolvedValue(overrides === null ? null : note(overrides));

    await expect(service.require(OWNER, NOTE_ID, 'view')).rejects.toMatchObject({
      status: 404,
      // ⚠ BYTE-IDENTICAL. Two differently-worded 404s would reintroduce exactly
      // the oracle the status code was chosen to remove.
      response: { message: NOTE_NOT_FOUND_MESSAGE },
    });
  });

  it.each(['view', 'edit', 'own'] as const)(
    'refuses a stranger at level %s with 404, never 403',
    async (level) => {
      prisma.note.findUnique.mockResolvedValue(note({ ownerId: 'somebody-else' }));

      await expect(
        service.require(OWNER, NOTE_ID, level, [PERMISSIONS.NOTES_WRITE]),
      ).rejects.toBeInstanceOf(NotFoundException);
    },
  );

  it('lets the owner through at every level, given the write permission', async () => {
    prisma.note.findUnique.mockResolvedValue(note());

    for (const level of ['view', 'edit', 'own'] as const) {
      await expect(
        service.require(OWNER, NOTE_ID, level, [PERMISSIONS.NOTES_WRITE]),
      ).resolves.toMatchObject({ role: 'owner' });
    }
  });

  it('is 403 — not 404 — for an owner without `notes:write`', async () => {
    prisma.note.findUnique.mockResolvedValue(note());

    // They can already SEE the note, so there is nothing left to conceal; a 404
    // here would tell them their own note had vanished.
    await expect(service.require(OWNER, NOTE_ID, 'edit', [])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(service.require(OWNER, NOTE_ID, 'view', [])).resolves.toBeDefined();
  });

  it('can see a soft-deleted note only when a caller explicitly asks — the purge path', async () => {
    prisma.note.findUnique.mockResolvedValue(note({ deletedAt: new Date() }));

    await expect(
      service.require(OWNER, NOTE_ID, 'view', [], { includeDeleted: true }),
    ).resolves.toMatchObject({ role: 'owner' });
  });

  it('reports a role for a list row without throwing for one it cannot see', () => {
    expect(service.roleFor(OWNER, { ownerId: OWNER })).toBe('owner');
    expect(service.roleFor(OWNER, { ownerId: 'somebody-else' })).toBeNull();
  });
});
