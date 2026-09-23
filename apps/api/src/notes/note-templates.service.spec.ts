import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { PrismaService } from '../prisma/prisma.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { NoteTemplatesService } from './note-templates.service';

// =============================================================================
// NoteTemplatesService (issue #50, epic #45; per-user hiding is issue #310)
// =============================================================================
//
// Unit-level coverage over a hand-rolled Prisma stand-in (the same shape
// `note-access.service.spec.ts` uses beside this file), so each assertion
// names exactly the `where` clause / audit payload / idempotent write it
// cares about, rather than reasoning about it through the HTTP layer.
//
// The over-the-wire contracts (401/403/404, the response envelope) live in
// `test/notes/note-templates.integration.spec.ts` and
// `test/notes/note-templates-hidden.integration.spec.ts` instead — this file
// is deliberately about the SERVICE's own decisions:
//
//   - `list()` excludes hidden templates by default and includes them (with
//     `hidden: true`) when asked, over the CALLER's own `hiddenBy` rows only.
//   - `hide()`/`unhide()` use `'read'` access — a built-in may be hidden,
//     another user's template is still a 404 — and are idempotent.
//   - `toResponse()` states `hidden` as an argument, never a column read.
// =============================================================================

const USER_ID = 'user-1';
const BUILT_IN_ID = 'built-in-1';
const OWNED_ID = 'owned-1';
const STRANGER_ID = 'stranger-1';

describe('NoteTemplatesService', () => {
  let service: NoteTemplatesService;
  let prisma: {
    noteTemplate: {
      findMany: jest.Mock;
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      delete: jest.Mock;
    };
    userHiddenNoteTemplate: {
      upsert: jest.Mock;
      deleteMany: jest.Mock;
      findUnique: jest.Mock;
    };
    note: { count: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  let access: { require: jest.Mock };

  const builtInRow = (overrides: Record<string, unknown> = {}) => ({
    id: BUILT_IN_ID,
    ownerId: null,
    name: 'Concise Meeting Notes',
    description: 'A short, scannable summary.',
    instructions: 'Write meeting notes.',
    outputFormat: 'meeting_notes',
    structure: ['Overview', 'Decisions'],
    tone: 'neutral',
    length: 'short',
    model: null,
    isArchived: false,
    createdAt: new Date('2026-09-14T00:00:00.000Z'),
    updatedAt: new Date('2026-09-14T00:00:00.000Z'),
    ...overrides,
  });

  const ownedRow = (overrides: Record<string, unknown> = {}) =>
    builtInRow({ id: OWNED_ID, ownerId: USER_ID, name: 'My notes', ...overrides });

  beforeEach(async () => {
    prisma = {
      noteTemplate: {
        findMany: jest.fn(),
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      userHiddenNoteTemplate: {
        upsert: jest.fn(),
        deleteMany: jest.fn(),
        findUnique: jest.fn(),
      },
      note: { count: jest.fn() },
      auditEvent: { create: jest.fn() },
    };

    access = { require: jest.fn() };

    const module = await Test.createTestingModule({
      providers: [
        NoteTemplatesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NoteTemplateAccessService, useValue: access },
      ],
    }).compile();

    service = module.get(NoteTemplatesService);
  });

  // ===========================================================================
  // list()
  // ===========================================================================

  describe('list()', () => {
    it('excludes hidden templates BY DEFAULT via `hiddenBy: { none: { userId } }`', async () => {
      prisma.noteTemplate.findMany.mockResolvedValue([]);

      await service.list(USER_ID, { includeArchived: false, includeHidden: false });

      const call = prisma.noteTemplate.findMany.mock.calls[0][0];

      expect(call.where).toMatchObject({
        OR: [{ ownerId: null }, { ownerId: USER_ID }],
        isArchived: false,
        hiddenBy: { none: { userId: USER_ID } },
      });
      // The `hiddenBy` include must be filtered to the CALLER — another
      // user's hide must never leak into this caller's `hidden` flag.
      expect(call.include).toMatchObject({
        hiddenBy: { where: { userId: USER_ID }, select: { userId: true } },
      });
    });

    it('includes hidden templates when `includeHidden: true`, and never narrows on `hiddenBy`', async () => {
      prisma.noteTemplate.findMany.mockResolvedValue([]);

      await service.list(USER_ID, { includeArchived: false, includeHidden: true });

      const where = prisma.noteTemplate.findMany.mock.calls[0][0].where;

      expect(where).not.toHaveProperty('hiddenBy');
    });

    it('computes `hidden` PER CALLER, from the filtered `hiddenBy` include, not a global column', async () => {
      prisma.noteTemplate.findMany.mockResolvedValue([
        { ...builtInRow(), hiddenBy: [{ userId: USER_ID }] },
        { ...ownedRow(), hiddenBy: [] },
      ]);

      const { items } = await service.list(USER_ID, { includeArchived: false, includeHidden: true });

      const byId = Object.fromEntries(items.map((item) => [item.id, item]));

      expect(byId[BUILT_IN_ID].hidden).toBe(true);
      expect(byId[OWNED_ID].hidden).toBe(false);
    });
  });

  // ===========================================================================
  // get()
  // ===========================================================================

  describe('get()', () => {
    it('returns `hidden` from the caller\'s own hidden-row lookup', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.userHiddenNoteTemplate.findUnique.mockResolvedValue({ userId: USER_ID });

      const response = await service.get(USER_ID, BUILT_IN_ID);

      expect(response.hidden).toBe(true);
      expect(prisma.userHiddenNoteTemplate.findUnique).toHaveBeenCalledWith({
        where: { userId_templateId: { userId: USER_ID, templateId: BUILT_IN_ID } },
        select: { userId: true },
      });
    });
  });

  // ===========================================================================
  // create() / duplicate() — always `hidden: false`
  // ===========================================================================

  describe('create()', () => {
    it('returns `hidden: false` — a row created a moment ago cannot have been hidden yet', async () => {
      prisma.noteTemplate.create.mockResolvedValue(ownedRow());

      const response = await service.create(USER_ID, {
        name: 'My notes',
        description: '',
        instructions: 'Write meeting notes.',
        outputFormat: 'meeting_notes',
        structure: [],
        tone: null,
        length: null,
        model: null,
      });

      expect(response.hidden).toBe(false);
      // No lookup performed — the fact is known, not queried.
      expect(prisma.userHiddenNoteTemplate.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('duplicate()', () => {
    it('returns `hidden: false` even when the SOURCE is hidden by the caller', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.noteTemplate.findMany.mockResolvedValue([]);
      prisma.noteTemplate.create.mockResolvedValue(ownedRow({ id: 'copy-1' }));

      const response = await service.duplicate(USER_ID, BUILT_IN_ID);

      expect(response.hidden).toBe(false);
    });
  });

  // ===========================================================================
  // update() — carries `hidden` through, does not decide it
  // ===========================================================================

  describe('update()', () => {
    it('returns `hidden` from the caller\'s own hidden-row lookup, not a constant', async () => {
      access.require.mockResolvedValue({ template: ownedRow(), builtIn: false });
      prisma.noteTemplate.update.mockResolvedValue(ownedRow({ instructions: 'Rewritten.' }));
      prisma.userHiddenNoteTemplate.findUnique.mockResolvedValue({ userId: USER_ID });

      const response = await service.update(USER_ID, OWNED_ID, { instructions: 'Rewritten.' });

      expect(response.hidden).toBe(true);
    });
  });

  // ===========================================================================
  // hide() (issue #310)
  // ===========================================================================

  describe('hide()', () => {
    it('checks READ access, not write — a built-in is allowed', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.userHiddenNoteTemplate.upsert.mockResolvedValue({});

      await service.hide(USER_ID, BUILT_IN_ID);

      expect(access.require).toHaveBeenCalledWith(USER_ID, BUILT_IN_ID, 'read');
    });

    it('upserts with an EMPTY update — hiding twice is a no-op, never a P2002', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.userHiddenNoteTemplate.upsert.mockResolvedValue({});

      await service.hide(USER_ID, BUILT_IN_ID);

      expect(prisma.userHiddenNoteTemplate.upsert).toHaveBeenCalledWith({
        where: { userId_templateId: { userId: USER_ID, templateId: BUILT_IN_ID } },
        create: { userId: USER_ID, templateId: BUILT_IN_ID },
        update: {},
      });
    });

    it('audits `note_template:hide` with `{ templateId, builtIn: true }` for a built-in', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.userHiddenNoteTemplate.upsert.mockResolvedValue({});

      await service.hide(USER_ID, BUILT_IN_ID);

      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: 'note_template:hide',
          targetType: 'note_template',
          targetId: BUILT_IN_ID,
          meta: { templateId: BUILT_IN_ID, builtIn: true },
        },
      });
    });

    it('audits `builtIn: false` for the caller\'s own custom template', async () => {
      access.require.mockResolvedValue({ template: ownedRow(), builtIn: false });
      prisma.userHiddenNoteTemplate.upsert.mockResolvedValue({});

      await service.hide(USER_ID, OWNED_ID);

      expect(prisma.auditEvent.create.mock.calls[0][0].data.meta).toEqual({
        templateId: OWNED_ID,
        builtIn: false,
      });
    });

    it('propagates the 404 access throws for another user\'s template, and writes nothing', async () => {
      access.require.mockRejectedValue(new NotFoundException('Note template not found'));

      await expect(service.hide(USER_ID, STRANGER_ID)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.userHiddenNoteTemplate.upsert).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });

    it('never throws Forbidden for a built-in — hiding is not gated by the write-immutability rule', async () => {
      // If `hide()` ever called `access.require(..., 'write')` this would
      // reject with ForbiddenException instead — pinning the level argument.
      access.require.mockImplementation(async (_userId: string, _id: string, level: string) => {
        if (level === 'write') throw new ForbiddenException('Built-in templates cannot be changed');

        return { template: builtInRow(), builtIn: true };
      });
      prisma.userHiddenNoteTemplate.upsert.mockResolvedValue({});

      await expect(service.hide(USER_ID, BUILT_IN_ID)).resolves.toBeUndefined();
    });
  });

  // ===========================================================================
  // unhide() (issue #310)
  // ===========================================================================

  describe('unhide()', () => {
    it('checks READ access, deleteManys the row, and audits `note_template:unhide`', async () => {
      access.require.mockResolvedValue({ template: builtInRow(), builtIn: true });
      prisma.userHiddenNoteTemplate.deleteMany.mockResolvedValue({ count: 1 });

      await service.unhide(USER_ID, BUILT_IN_ID);

      expect(access.require).toHaveBeenCalledWith(USER_ID, BUILT_IN_ID, 'read');
      expect(prisma.userHiddenNoteTemplate.deleteMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, templateId: BUILT_IN_ID },
      });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith({
        data: {
          actorUserId: USER_ID,
          action: 'note_template:unhide',
          targetType: 'note_template',
          targetId: BUILT_IN_ID,
          meta: { templateId: BUILT_IN_ID, builtIn: true },
        },
      });
    });

    it('succeeds when the template was not hidden — `deleteMany` never throws on zero rows', async () => {
      access.require.mockResolvedValue({ template: ownedRow(), builtIn: false });
      prisma.userHiddenNoteTemplate.deleteMany.mockResolvedValue({ count: 0 });

      await expect(service.unhide(USER_ID, OWNED_ID)).resolves.toBeUndefined();
    });

    it('is a 404 for another user\'s template, and writes nothing', async () => {
      access.require.mockRejectedValue(new NotFoundException('Note template not found'));

      await expect(service.unhide(USER_ID, STRANGER_ID)).rejects.toBeInstanceOf(NotFoundException);

      expect(prisma.userHiddenNoteTemplate.deleteMany).not.toHaveBeenCalled();
      expect(prisma.auditEvent.create).not.toHaveBeenCalled();
    });
  });
});
