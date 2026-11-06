import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';

import { createNotesServiceTestFactory } from '../../src/notes/testing/notes-service-test-factory.js';
import { createInMemoryNotesDb } from '../../src/notes/testing/in-memory-notes-db.js';
import type { NoteContextAttachment } from '@marinoscar/kvox-contract/notes';

// =============================================================================
// NotesService: context attachments on create and regenerate (issue #810)
// =============================================================================
//
// The collaborators are stubs; what is pinned is what the SERVICE does with the ids: validate before
// anything exists, persist rows in the order given, snapshot onto the generation, and keep, replace
// or clear on regenerate exactly as `contextText` does.
// =============================================================================

const USER = { id: 'user-1', permissions: ['notes:read', 'notes:write'] };
const TEMPLATE = {
  id: 'template-1',
  name: 'Meeting notes',
  instructions: 'Summarize.',
  outputFormat: 'markdown',
  structure: null,
  tone: null,
  length: null,
  model: null,
  bodyFormat: 'markdown',
};
const SELECTOR = { sourceType: 'transcript', sourceTranscriptId: 't-1', sourceNoteId: null, sourceObjectId: null };

const DOC: NoteContextAttachment = { objectId: 'doc-1', kind: 'document', filename: 'agenda.md', mimeType: 'text/markdown' };
const IMG: NoteContextAttachment = { objectId: 'img-1', kind: 'image', filename: 'board.png', mimeType: 'image/png' };

function build(opts: { attachments?: { resolve: jest.Mock; forNote: jest.Mock } | null } = {}) {
  const memory = createInMemoryNotesDb();
  const attachments =
    opts.attachments === undefined
      ? { resolve: jest.fn(async (ids: string[]) => ids.map((id) => (id === 'img-1' ? IMG : DOC))), forNote: jest.fn(async () => [DOC]) }
      : opts.attachments;

  const requests = {
    resolveSource: jest.fn().mockResolvedValue(SELECTOR),
    resolveModel: jest.fn().mockResolvedValue({ providerId: 'openai', model: 'gpt-4o', target: { model: 'gpt-4o' }, caps: {} }),
    assertPromptFits: jest.fn(),
    assertVisionSupported: jest.fn().mockResolvedValue(undefined),
  };
  const sources = {
    resolve: jest.fn().mockResolvedValue({ text: 'transcript', describe: 'transcript', sourceVersion: 1 }),
    resolveContextDocuments: jest.fn(async (docs: Array<{ objectId: string }>) =>
      docs.map((d) => ({ filename: `${d.objectId}.md`, text: 'attached text' })),
    ),
  };
  const jobs = { enqueueWithin: jest.fn().mockResolvedValue({ id: 'job-1' }), enqueue: jest.fn() };

  const service = createNotesServiceTestFactory({
    prisma: memory.db,
    audit: { record: jest.fn().mockResolvedValue(undefined) } as never,
    jobs: jobs as never,
    access: {
      require: jest.fn(async (_u: string, id: string) => ({ note: memory.notes.find((n) => n.id === id), role: 'owner' })),
    } as never,
    sourceNames: { resolveOne: jest.fn().mockResolvedValue(null) } as never,
    templates: { require: jest.fn().mockResolvedValue({ template: TEMPLATE, builtIn: true }) } as never,
    requests: requests as never,
    sources: sources as never,
    searchIndex: { enqueue: jest.fn() } as never,
    origins: { resolve: jest.fn().mockResolvedValue(null) } as never,
    ...(attachments ? { contextAttachments: attachments as never } : {}),
  });

  return { service, memory, attachments, requests, sources };
}

const createDto = (ids?: string[]) =>
  ({ templateId: TEMPLATE.id, source: { type: 'transcript', transcriptId: 't-1' }, ...(ids ? { contextAttachmentIds: ids } : {}) }) as never;

describe('NotesService.create with context attachments', () => {
  it('validates the ids for the caller, persists rows in the order given and snapshots them onto the generation', async () => {
    const { service, memory, attachments, requests, sources } = build();

    const out = await service.create(createDto(['doc-1', 'img-1']), USER);

    expect(attachments?.resolve).toHaveBeenCalledWith(['doc-1', 'img-1'], 'user-1');
    expect(memory.attachments.map((a) => [a.objectId, a.ordinal, a.kind])).toEqual([
      ['doc-1', 0, 'document'],
      ['img-1', 1, 'image'],
    ]);
    expect(memory.generations[0]?.contextAttachments).toEqual([DOC, IMG]);
    expect(out.note.contextAttachments).toEqual([DOC, IMG]);
    // The budget check sees the documents' text, and the vision check sees the images.
    expect(sources.resolveContextDocuments).toHaveBeenCalledWith([DOC]);
    expect(requests.assertVisionSupported).toHaveBeenCalledWith('user-1', { model: 'gpt-4o' }, [DOC, IMG]);
  });

  it('creates nothing when an attachment is refused (not ready, not yours, over the limit)', async () => {
    for (const failure of [new ConflictException('not ready'), new NotFoundException(), new BadRequestException('limit')]) {
      const { service, memory } = build({ attachments: { resolve: jest.fn().mockRejectedValue(failure), forNote: jest.fn() } });

      await expect(service.create(createDto(['doc-1']), USER)).rejects.toBe(failure);
      expect(memory.notes).toHaveLength(0);
      expect(memory.generations).toHaveLength(0);
      expect(memory.attachments).toHaveLength(0);
    }
  });

  it('creates nothing when the model cannot read an attached image', async () => {
    const { service, memory, requests } = build();
    const refusal = new ConflictException({ details: { reason: 'ai_model_no_vision' } });
    requests.assertVisionSupported.mockRejectedValue(refusal);

    await expect(service.create(createDto(['img-1']), USER)).rejects.toBe(refusal);
    expect(memory.notes).toHaveLength(0);
  });

  it('writes no attachment rows and a null snapshot when none are named', async () => {
    const { service, memory, requests } = build();

    await service.create(createDto(), USER);

    expect(memory.attachments).toHaveLength(0);
    expect(memory.generations[0]?.contextAttachments).toBeNull();
    expect(requests.assertVisionSupported).not.toHaveBeenCalled();
  });

  it('refuses ids it cannot validate rather than ignoring them (a host without the service)', async () => {
    const { service } = build({ attachments: null });

    await expect(service.create(createDto(['doc-1']), USER)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('NotesService.regenerate with context attachments', () => {
  async function created(opts: Parameters<typeof build>[0] = {}) {
    const ctx = build(opts);
    const { note } = await ctx.service.create(createDto(['doc-1']), USER);
    // The in-memory `forNote` stub answers what the note has now.
    return { ...ctx, noteId: note.id };
  }

  it('keeps the note\'s attachments when the field is omitted, and snapshots them', async () => {
    const { service, memory, attachments, noteId } = await created();
    attachments!.resolve.mockClear();
    const before = memory.attachments.length;

    await service.regenerate(noteId, {} as never, USER);

    expect(attachments!.resolve).not.toHaveBeenCalled();
    expect(memory.attachments).toHaveLength(before);
    expect(memory.generations.at(-1)?.contextAttachments).toEqual([DOC]);
  });

  it('replaces them when an array is sent', async () => {
    const { service, memory, noteId } = await created();
    memory.notes.find((n) => n.id === noteId)!.status = 'ready';

    await service.regenerate(noteId, { contextAttachmentIds: ['img-1'] } as never, USER);

    expect(memory.attachments.map((a) => a.objectId)).toEqual(['img-1']);
    expect(memory.generations.at(-1)?.contextAttachments).toEqual([IMG]);
  });

  it('clears them when null is sent', async () => {
    const { service, memory, noteId } = await created();
    memory.notes.find((n) => n.id === noteId)!.status = 'ready';

    await service.regenerate(noteId, { contextAttachmentIds: null } as never, USER);

    expect(memory.attachments).toHaveLength(0);
    expect(memory.generations.at(-1)?.contextAttachments).toBeNull();
  });
});
