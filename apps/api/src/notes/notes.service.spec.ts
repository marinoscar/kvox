import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { Note } from '@prisma/client';

import type { RequestUser } from '../auth/interfaces/authenticated-user.interface';
import { JobsService } from '../jobs/jobs.service';
import { SearchIndexService } from '../search/indexing/search-index.service';
import { PrismaService } from '../prisma/prisma.service';
import { NoteAccessService } from './access/note-access.service';
import { NoteOriginService } from './note-origin.service';
import { NoteSourceNameService } from './note-source-name.service';
import { NoteTemplateAccessService } from './access/note-template-access.service';
import { noteResponseSchema, RETITLE_SWEEP_LIMIT } from './dto/note.dto';
import { NoteGenerationRequestService } from './generation/note-generation-request.service';
import { NoteSourceService } from './generation/note-source.service';
import { NOTE_RETITLE_JOB_TYPE, NOTE_SUBJECT_TYPE } from './job-types';
import { detailShape, NOTE_RETITLE_JOB_PRIORITY, NotesService } from './notes.service';

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
  let searchIndex: { enqueue: jest.Mock };

  beforeEach(async () => {
    prisma = {
      note: {
        create: jest.fn().mockResolvedValue(noteRow({ status: 'draft', currentVersion: 0 })),
        update: jest.fn().mockResolvedValue(noteRow()),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(noteRow()),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
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
      resolve: jest.fn().mockResolvedValue({ text: 'the transcript text', describe: 'transcript', sourceVersion: 1 }),
    };

    jobs = {
      enqueue: jest.fn().mockResolvedValue({ id: 'job-1' }),
      enqueueWithin: jest.fn().mockResolvedValue({ id: 'job-1' }),
    };

    // #188: every committed content change queues a semantic re-index —
    // including a RENAME, because a note's title is prefixed onto every one of
    // its chunks. (A transcript rename deliberately does not; see
    // `TranscriptPipelineService.enqueueSearchIndex`.)
    searchIndex = { enqueue: jest.fn().mockResolvedValue(undefined) };

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
        { provide: SearchIndexService, useValue: searchIndex },
        // #309. Stubbed to `null` — a real production answer (no readable
        // origin) — for the same reason the source-name resolver is stubbed.
        { provide: NoteOriginService, useValue: { resolve: jest.fn().mockResolvedValue(null) } },
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

  describe('create — bodyFormat (#334)', () => {
    const dto = {
      templateId: TEMPLATE_ID,
      source: { type: 'transcript' as const, transcriptId: 'transcript-1' },
    };

    it('sets the note\'s bodyFormat from a markdown template', async () => {
      await service.create(dto, USER);

      expect(prisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bodyFormat: 'markdown' }) }),
      );
    });

    it('sets the note\'s bodyFormat to plain_text from a plain_text template', async () => {
      templates.require.mockResolvedValue({
        template: templateRow({ bodyFormat: 'plain_text' }),
        builtIn: true,
      });

      await service.create(dto, USER);

      expect(prisma.note.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ bodyFormat: 'plain_text' }) }),
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

  describe('getVersion — bodyFormat (#334)', () => {
    const versionRow = {
      noteId: NOTE_ID,
      version: 2,
      kind: 'edit',
      summary: null,
      author: null,
      generationId: null,
      restoredFromVersion: null,
      body: 'Plain text, *not* emphasis.',
      createdAt: new Date('2026-01-03T00:00:00.000Z'),
    };

    it('reports the note\'s plain_text format on a version', async () => {
      access.require.mockResolvedValue({ note: noteRow({ bodyFormat: 'plain_text' }), role: 'owner' });
      prisma.noteVersion.findUnique.mockResolvedValue(versionRow);

      const result = await service.getVersion(NOTE_ID, 2, USER);

      expect(result.bodyFormat).toBe('plain_text');
      expect(result.isCurrent).toBe(false);
    });

    it('defaults an unrecognised stored format to markdown', async () => {
      access.require.mockResolvedValue({ note: noteRow({ bodyFormat: 'html' }), role: 'owner' });
      prisma.noteVersion.findUnique.mockResolvedValue(versionRow);

      const result = await service.getVersion(NOTE_ID, 2, USER);

      expect(result.bodyFormat).toBe('markdown');
    });
  });

  // ===========================================================================
  // Retitle (issue #184, epic #163)
  // ===========================================================================

  describe('retitle — one note, the "Suggest a title" button', () => {
    it('is a 404 for a note the caller cannot see (whatever NoteAccessService throws)', async () => {
      access.require.mockRejectedValue(new NotFoundException('No such note, or no access to it.'));

      await expect(service.retitle(NOTE_ID, USER)).rejects.toBeInstanceOf(NotFoundException);
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('is a 409 carrying the GENERATING reason while the note is generating', async () => {
      access.require.mockResolvedValue({
        note: noteRow({ status: 'generating' }),
        role: 'owner',
      });

      let thrown: ConflictException | undefined;

      try {
        await service.retitle(NOTE_ID, USER);
      } catch (error) {
        thrown = error as ConflictException;
      }

      expect(thrown).toBeInstanceOf(ConflictException);
      expect(
        (thrown?.getResponse() as { details: { reason: string } }).details,
      ).toEqual({ reason: 'generating' });
      expect(jobs.enqueue).not.toHaveBeenCalled();
    });

    it('enqueues note.retitle with force: true, skipDedup: true, no explicit priority, and audits it', async () => {
      access.require.mockResolvedValue({ note: noteRow(), role: 'owner' });

      const result = await service.retitle(NOTE_ID, USER);

      expect(jobs.enqueue).toHaveBeenCalledWith(
        expect.objectContaining({
          type: NOTE_RETITLE_JOB_TYPE,
          subjectType: NOTE_SUBJECT_TYPE,
          subjectId: NOTE_ID,
          payload: { noteId: NOTE_ID, force: true },
          skipDedup: true,
        }),
      );

      // ⚠ NO explicit priority: the column default outranks the bulk sweep,
      // which is the whole reason `NOTE_RETITLE_JOB_PRIORITY` exists as a
      // constant the sweep alone passes.
      const [enqueued] = jobs.enqueue.mock.calls[0];

      expect(enqueued).not.toHaveProperty('priority');
      expect(enqueued.payload.force).toBe(true);

      expect(result).toEqual({ noteId: NOTE_ID, jobId: 'job-1' });
      expect(prisma.auditEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'note:retitle',
            targetType: 'note',
            targetId: NOTE_ID,
          }),
        }),
      );
    });
  });

  describe('retitleAll — the bulk sweep', () => {
    const noteIds = (count: number) => Array.from({ length: count }, (_, i) => ({ id: `note-${i}` }));

    it(
      'selects `titleSource: "template"` — narrower than "not user", which is what lets the sweep terminate ' +
        '(a success writes "ai", so "not user" would never shrink)',
      async () => {
        prisma.note.count.mockResolvedValue(0);
        prisma.note.findMany.mockResolvedValue([]);

        await service.retitleAll(USER);

        const expectedWhere = {
          ownerId: USER.id,
          deletedAt: null,
          status: 'ready',
          titleSource: 'template',
        };

        expect(prisma.note.count).toHaveBeenCalledWith({ where: expectedWhere });
        expect(prisma.note.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ where: expectedWhere }),
        );
      },
    );

    it('orders oldest `updatedAt` first, so a titled note falls to the back of the next page', async () => {
      prisma.note.count.mockResolvedValue(0);
      prisma.note.findMany.mockResolvedValue([]);

      await service.retitleAll(USER);

      expect(prisma.note.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }] }),
      );
    });

    it('caps the page at RETITLE_SWEEP_LIMIT', async () => {
      prisma.note.count.mockResolvedValue(0);
      prisma.note.findMany.mockResolvedValue([]);

      await service.retitleAll(USER);

      expect(prisma.note.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: RETITLE_SWEEP_LIMIT }),
      );
    });

    it('queues one job per note, none with skipDedup, all at NOTE_RETITLE_JOB_PRIORITY, no force', async () => {
      prisma.note.count.mockResolvedValue(2);
      prisma.note.findMany.mockResolvedValue(noteIds(2));

      await service.retitleAll(USER);

      expect(jobs.enqueue).toHaveBeenCalledTimes(2);

      for (const [input] of jobs.enqueue.mock.calls) {
        expect(input.type).toBe(NOTE_RETITLE_JOB_TYPE);
        expect(input.priority).toBe(NOTE_RETITLE_JOB_PRIORITY);
        expect(input).not.toHaveProperty('skipDedup');
        expect(input.payload).not.toHaveProperty('force');
      }

      expect(jobs.enqueue).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ subjectId: 'note-0', payload: { noteId: 'note-0' } }),
      );
      expect(jobs.enqueue).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ subjectId: 'note-1', payload: { noteId: 'note-1' } }),
      );
    });

    it('remaining is 0 when fewer notes match than the cap', async () => {
      prisma.note.count.mockResolvedValue(2);
      prisma.note.findMany.mockResolvedValue(noteIds(2));

      const result = await service.retitleAll(USER);

      expect(result).toEqual({ queued: 2, remaining: 0 });
    });

    it('queued === cap and remaining === total - cap when more notes match than the cap', async () => {
      prisma.note.count.mockResolvedValue(RETITLE_SWEEP_LIMIT + 50);
      prisma.note.findMany.mockResolvedValue(noteIds(RETITLE_SWEEP_LIMIT));

      const result = await service.retitleAll(USER);

      expect(result).toEqual({ queued: RETITLE_SWEEP_LIMIT, remaining: 50 });
    });

    it('an empty library queues nothing and returns { queued: 0, remaining: 0 }', async () => {
      prisma.note.count.mockResolvedValue(0);
      prisma.note.findMany.mockResolvedValue([]);

      const result = await service.retitleAll(USER);

      expect(result).toEqual({ queued: 0, remaining: 0 });
      expect(jobs.enqueue).not.toHaveBeenCalled();
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
