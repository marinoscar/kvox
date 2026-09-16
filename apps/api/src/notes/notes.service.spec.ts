import { Test } from '@nestjs/testing';
import type { Note } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../jobs/jobs.service';
import { PrismaService } from '../prisma/prisma.service';
import { NoteAccessService } from './access/note-access.service';
import { NoteSourceNameService } from './note-source-name.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { noteResponseSchema } from './dto/note.dto';
import { NoteGenerationRequestService } from './generation/note-generation-request.service';
import { NoteSourceService } from './generation/note-source.service';
import { detailShape, NotesService } from './notes.service';

// =============================================================================
// NotesService — title provenance (`titleSource`, issue #180, epic #163)
// =============================================================================
//
// `titleSource` is set at exactly three sites in `notes.service.ts`: `create()`
// (`user` for a supplied title, `template` for the template-name fallback),
// `update()`'s metadata-only branch (always `user`), and `commitVersion()`
// (`user` only when a title rode along with a body save — never for a
// body-only save or a restore, both of which must leave the column alone).
// These specs pin exactly that, asserting on the literal Prisma call
// arguments the same way `transcripts.service.spec.ts` does for its own
// service, rather than on the (mocked) return value.
// =============================================================================

const USER: RequestUser = {
  id: 'user-1',
  email: 'owner@example.com',
  roles: ['contributor'],
  permissions: ['notes:read', 'notes:write'],
  isActive: true,
};

const NOTE_ID = 'note-1';
const TEMPLATE_ID = 'template-1';

const noteRow = (overrides: Record<string, unknown> = {}) => ({
  id: NOTE_ID,
  ownerId: USER.id,
  title: 'Weekly sync',
  titleSource: 'template',
  body: 'Some existing body.',
  status: 'ready',
  currentVersion: 3,
  provider: 'openai',
  model: 'gpt-4o',
  currentGenerationId: 'generation-1',
  sourceType: 'transcript',
  sourceTranscriptId: 'transcript-1',
  sourceNoteId: null,
  sourceObjectId: null,
  templateId: TEMPLATE_ID,
  contextText: null,
  failureReason: null,
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  ...overrides,
});

const templateRow = (overrides: Record<string, unknown> = {}) => ({
  id: TEMPLATE_ID,
  ownerId: null,
  name: 'Meeting notes',
  description: null,
  instructions: 'Summarize the meeting.',
  outputFormat: 'markdown',
  structure: null,
  tone: null,
  length: null,
  model: null,
  isArchived: false,
  createdAt: new Date('2025-01-01T00:00:00.000Z'),
  updatedAt: new Date('2025-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('NotesService', () => {
  let service: NotesService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prisma: Record<string, any>;
  let access: { require: jest.Mock };
  let templates: { require: jest.Mock };
  let requests: { resolveSource: jest.Mock; resolveModel: jest.Mock; assertPromptFits: jest.Mock };
  let sources: { resolve: jest.Mock };
  let jobs: { enqueue: jest.Mock; enqueueWithin: jest.Mock };

  beforeEach(async () => {
    prisma = {
      note: {
        create: jest.fn().mockResolvedValue(noteRow({ status: 'draft', currentVersion: 0 })),
        update: jest.fn().mockResolvedValue(noteRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(noteRow()),
        findMany: jest.fn().mockResolvedValue([]),
      },
      noteVersion: {
        create: jest.fn().mockResolvedValue({}),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      noteGeneration: {
        create: jest.fn().mockResolvedValue({ id: 'generation-1' }),
        update: jest.fn().mockResolvedValue({}),
      },
      noteTemplate: {
        findUnique: jest.fn().mockResolvedValue({ name: 'Meeting notes' }),
      },
      auditEvent: { create: jest.fn().mockResolvedValue({}) },
      $transaction: jest.fn(async (callback: (tx: unknown) => unknown) => callback(prisma)),
    };

    access = {
      require: jest.fn().mockResolvedValue({ note: noteRow(), role: 'owner' }),
    };

    templates = {
      require: jest.fn().mockResolvedValue({ template: templateRow(), builtIn: true }),
    };

    requests = {
      resolveSource: jest.fn().mockResolvedValue({
        sourceType: 'transcript',
        sourceTranscriptId: 'transcript-1',
        sourceNoteId: null,
        sourceObjectId: null,
      }),
      resolveModel: jest.fn().mockResolvedValue({
        provider: { id: 'openai' },
        model: 'gpt-4o',
        policy: {},
      }),
      assertPromptFits: jest.fn(),
    };

    sources = {
      resolve: jest.fn().mockResolvedValue({ text: 'the transcript text', describe: 'transcript' }),
    };

    jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
      enqueueWithin: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    const module = await Test.createTestingModule({
      providers: [
        NotesService,
        { provide: PrismaService, useValue: prisma },
        { provide: NoteAccessService, useValue: access },
        // #192. Stubbed rather than real: this suite is about title
        // provenance, and a resolver reading three tables through the same
        // `prisma` stub would make every assertion here depend on fixtures for
        // a question it is not asking. `null` is a real production answer (a
        // deleted or unreadable source), so the shapes stay valid.
        {
          provide: NoteSourceNameService,
          useValue: {
            resolve: jest.fn().mockResolvedValue(new Map<string, string>()),
            resolveOne: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: NoteTemplateAccessService, useValue: templates },
        { provide: NoteGenerationRequestService, useValue: requests },
        { provide: NoteSourceService, useValue: sources },
        { provide: JobsService, useValue: jobs },
      ],
    }).compile();

    service = module.get(NotesService);
  });

  describe('create — title provenance', () => {
    const dto = {
      templateId: TEMPLATE_ID,
      source: { type: 'transcript' as const, transcriptId: 'transcript-1' },
    };

    it('records a supplied title as user-chosen', async () => {
      await service.create({ ...dto, title: 'My kickoff notes' }, USER);

      expect(prisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: 'My kickoff notes', titleSource: 'user' }),
        }),
      );
      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'note:create',
            meta: expect.objectContaining({ title: 'My kickoff notes', titleSource: 'user' }),
          }),
        }),
      );
    });

    it('falls back to the template name and records it as template-chosen when no title is supplied', async () => {
      await service.create(dto, USER);

      expect(prisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: 'Meeting notes', titleSource: 'template' }),
        }),
      );
    });

    it('treats a whitespace-only title as absent, not as a user choice', async () => {
      await service.create({ ...dto, title: '   ' }, USER);

      expect(prisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ title: 'Meeting notes', titleSource: 'template' }),
        }),
      );
    });
  });

  describe('update — a rename always claims the change', () => {
    it('marks the title user-chosen on a metadata-only rename', async () => {
      await service.update(NOTE_ID, { title: 'Renamed by hand' }, USER);

      expect(prisma.note.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: NOTE_ID },
          data: { title: 'Renamed by hand', titleSource: 'user' },
        }),
      );
    });
  });

  describe('update — a body save that also renames', () => {
    it('commits both the new title and its user provenance together', async () => {
      access.require.mockResolvedValue({
        note: noteRow({ currentVersion: 3, status: 'ready' }),
        role: 'owner',
      });

      await service.update(
        NOTE_ID,
        { title: 'Renamed while editing', body: 'A rewritten body.', baseVersion: 3 },
        USER,
      );

      expect(prisma.note.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            title: 'Renamed while editing',
            titleSource: 'user',
            body: 'A rewritten body.',
          }),
        }),
      );
    });
  });

  describe('update — a body-only save', () => {
    it('never touches titleSource, so a routine edit cannot silently claim the user named the note', async () => {
      access.require.mockResolvedValue({
        note: noteRow({ currentVersion: 3, status: 'ready' }),
        role: 'owner',
      });

      await service.update(NOTE_ID, { body: 'Just fixing a typo.', baseVersion: 3 }, USER);

      const call = prisma.note.updateMany.mock.calls[0][0];

      expect(call.data).not.toHaveProperty('titleSource');
      expect(call.data).not.toHaveProperty('title');
    });
  });

  describe('restore', () => {
    it('leaves titleSource untouched when restoring an earlier version', async () => {
      access.require.mockResolvedValue({
        note: noteRow({ currentVersion: 5, status: 'ready' }),
        role: 'owner',
      });
      prisma.noteVersion.findUnique.mockResolvedValue({
        version: 3,
        body: 'An older body.',
      });

      await service.restore(NOTE_ID, 3, { baseVersion: 5 }, USER);

      const call = prisma.note.updateMany.mock.calls[0][0];

      expect(call.data).not.toHaveProperty('titleSource');
      expect(call.data).not.toHaveProperty('title');
      // And the body IS the restored one — confirms this is the real commit
      // path, not a call that happened to skip both keys for another reason.
      expect(call.data).toEqual(expect.objectContaining({ body: 'An older body.' }));
    });
  });
});

describe('detailShape and noteResponseSchema (#180)', () => {
  it('detailShape publishes titleSource on the note detail projection', () => {
    const note = noteRow({ titleSource: 'ai' }) as unknown as Note;

    const shaped = detailShape(note, 'Meeting notes');

    expect(shaped.titleSource).toBe('ai');
  });

  it('noteResponseSchema parses a response carrying a valid titleSource', () => {
    const note = noteRow({ titleSource: 'user' }) as unknown as Note;
    const shaped = detailShape(note, 'Meeting notes');

    const parsed = noteResponseSchema.parse(shaped);

    expect(parsed.titleSource).toBe('user');
  });

  it('noteResponseSchema rejects a titleSource outside ai/user/template', () => {
    const note = noteRow({ titleSource: 'user' }) as unknown as Note;
    const shaped = detailShape(note, 'Meeting notes');

    expect(() => noteResponseSchema.parse({ ...shaped, titleSource: 'robot' })).toThrow();
  });
});
