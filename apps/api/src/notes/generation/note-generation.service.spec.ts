import type { Note, NoteGeneration } from '@prisma/client';

import { NoteGenerationService, readPayloadTemplate, type GenerationWithNote } from './note-generation.service';
import { NoteTitleService } from './note-title.service';

// =============================================================================
// NoteGenerationService.commit() — the titling hook (issue #182, epic #163)
// =============================================================================
//
// `commit()` is one transaction (the buffer, the body, the version, the
// status) followed by two calls OUTSIDE it, in a fixed order: name the note,
// then tell the owner. This file pins that order and the two edge cases the
// docs call out explicitly:
//
//   • a PREVIEW is never titled — it has no note to name;
//   • a titling failure can never fail the note. `titleNote`'s own contract
//     is that it never throws, and `commit()` catches anyway — two
//     enforcement points for one invariant. The test below exercises the
//     second one, because it is the only one a stubbed `titleNote` can reach.
// =============================================================================

const NOTE_ID = 'note-1';
const OWNER_ID = 'owner-1';

function noteRow(overrides: Partial<Note> = {}): Note {
  return {
    id: NOTE_ID,
    ownerId: OWNER_ID,
    title: 'Meeting notes',
    titleSource: 'template',
    body: '',
    status: 'draft',
    currentVersion: 0,
    provider: null,
    model: null,
    currentGenerationId: 'gen-1',
    sourceType: 'transcript',
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
    templateId: 'template-1',
    contextText: null,
    failureReason: null,
    deletedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  } as unknown as Note;
}

function generationRow(overrides: Record<string, unknown> = {}): GenerationWithNote {
  const noteId = overrides.noteId === undefined ? NOTE_ID : (overrides.noteId as string | null);
  const note = overrides.note === undefined ? (noteId ? noteRow() : null) : (overrides.note as Note | null);

  return {
    id: 'gen-1',
    noteId,
    kind: 'create',
    status: 'streaming',
    templateId: 'template-1',
    templateNameSnapshot: 'Meeting notes',
    contextText: null,
    sourceType: 'transcript',
    sourceTranscriptId: 'transcript-1',
    sourceNoteId: null,
    sourceObjectId: null,
    providerId: 'openai',
    model: 'gpt-4o',
    content: '',
    lastEventId: 0,
    promptTokens: null,
    completionTokens: null,
    startedAt: new Date(),
    completedAt: null,
    errorClass: null,
    errorDetail: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
    note,
  } as unknown as GenerationWithNote;
}

interface Tx {
  noteGeneration: { update: jest.Mock };
  note: { findUnique: jest.Mock; update: jest.Mock };
  noteVersion: { create: jest.Mock };
}

function harness(options: { noteAfterRead?: Record<string, unknown> | null } = {}) {
  const tx: Tx = {
    noteGeneration: { update: jest.fn().mockResolvedValue({}) },
    note: {
      findUnique: jest.fn().mockResolvedValue(
        options.noteAfterRead === undefined
          ? { id: NOTE_ID, currentVersion: 0, status: 'draft', deletedAt: null }
          : options.noteAfterRead,
      ),
      update: jest.fn().mockResolvedValue({}),
    },
    noteVersion: { create: jest.fn().mockResolvedValue({}) },
  };

  const prisma = {
    $transaction: jest.fn(async (callback: (tx: Tx) => unknown) => callback(tx)),
    noteGeneration: { update: jest.fn().mockResolvedValue({}) },
  };

  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue('https://app.example.com') };
  const titles = { titleNote: jest.fn().mockResolvedValue('AI-proposed title') };
  // #188: a committed note queues its own semantic re-index, after titling.
  const searchIndex = { enqueue: jest.fn().mockResolvedValue(undefined) };

  const service = new NoteGenerationService(
    prisma as never,
    notifications as never,
    config as never,
    titles as unknown as NoteTitleService,
    searchIndex as never,
  );

  return { service, prisma, tx, notifications, config, titles, searchIndex };
}

const commitInput = (generation: GenerationWithNote) => ({
  generation,
  content: '# Kestrel\n\nWe ship on Friday.',
  promptTokens: 120,
  completionTokens: 8,
  providerLabel: 'OpenAI',
});

// -----------------------------------------------------------------------------
// A preview is never titled
// -----------------------------------------------------------------------------

describe('commit() — a preview (noteId === null) is never titled', () => {
  it('does not call titleNote, and raises no notification, for a preview generation', async () => {
    const { service, titles, notifications, tx } = harness();
    const generation = generationRow({ noteId: null, note: null });

    await service.commit(commitInput(generation));

    // The transaction itself still ran (the generation row is settled either
    // way) but stopped before touching a note.
    expect(tx.noteGeneration.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'succeeded' }) }),
    );
    expect(tx.note.findUnique).not.toHaveBeenCalled();
    expect(titles.titleNote).not.toHaveBeenCalled();
    expect(notifications.notify).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Ordering: transaction, then titling, then notify — and the email's title
// -----------------------------------------------------------------------------

describe('commit() — titling runs after the transaction and before notify', () => {
  it('calls titleNote only after the transaction has resolved, and notify only after titleNote resolves', async () => {
    const order: string[] = [];
    const { service, prisma, tx, titles, notifications } = harness();

    prisma.$transaction.mockImplementation(async (callback: (tx: Tx) => unknown) => {
      order.push('transaction:start');
      const result = await callback(tx);
      order.push('transaction:end');

      return result;
    });
    titles.titleNote.mockImplementation(async () => {
      order.push('titleNote');

      return 'AI-proposed title';
    });
    notifications.notify.mockImplementation(async () => {
      order.push('notify');
    });

    await service.commit(commitInput(generationRow()));

    expect(order).toEqual(['transaction:start', 'transaction:end', 'titleNote', 'notify']);
  });

  it('titles from the just-committed content, addressed to the note and its owner', async () => {
    const { service, titles } = harness();
    const generation = generationRow();

    await service.commit(commitInput(generation));

    expect(titles.titleNote).toHaveBeenCalledWith({
      noteId: NOTE_ID,
      ownerId: OWNER_ID,
      body: '# Kestrel\n\nWe ship on Friday.',
      providerId: 'openai',
      model: 'gpt-4o',
    });
  });

  it('the "notes.note_ready" payload carries the POST-TITLING title, not the pre-generation one', async () => {
    const { service, titles, notifications } = harness();
    titles.titleNote.mockResolvedValue('A title only the model could have written');

    await service.commit(commitInput(generationRow()));

    expect(notifications.notify).toHaveBeenCalledWith(
      'notes.note_ready',
      OWNER_ID,
      expect.objectContaining({ title: 'A title only the model could have written' }),
    );
  });

  it('falls back to the note\'s own (pre-titling) title when titleNote returns null', async () => {
    const { service, titles, notifications } = harness();
    titles.titleNote.mockResolvedValue(null);

    await service.commit(commitInput(generationRow()));

    expect(notifications.notify).toHaveBeenCalledWith(
      'notes.note_ready',
      OWNER_ID,
      expect.objectContaining({ title: 'Meeting notes' }),
    );
  });
});

// -----------------------------------------------------------------------------
// The property the whole design rests on
// -----------------------------------------------------------------------------

describe('commit() — the never-throws property, enforced at the call site too', () => {
  // ⚠ THIS PINS THE SECOND ENFORCEMENT POINT, AND ONLY IT CAN BE TESTED HERE.
  //
  // `titleNote`'s own contract is that it never throws: every rank is wrapped
  // and its outermost `try` covers even the database reads. A stub cannot
  // exercise that contract — it replaces it. What this test reaches is
  // `commit()`'s own try/catch, which exists for the case where that contract
  // is broken: a future bug in `NoteTitleService`, or a DI substitution that
  // does not honour it.
  //
  // What it protects: `commit()` is called from inside
  // `NoteGenerateHandler.generate()`'s try block, so a rejection escaping here
  // would be caught by the handler, classified `'other'`, and fed to
  // `markFailed()` — flipping an already-committed, already-`ready` note to
  // `status: 'failed'` and firing `notes.note_failed` instead of
  // `notes.note_ready`, in front of a user who had just watched that note being
  // written. The note is committed and durable before this line runs; nothing
  // about naming it may undo that.
  it('resolves, still notifies, and keeps the pre-titling title when titleNote rejects', async () => {
    const { service, titles, notifications } = harness();
    titles.titleNote.mockRejectedValue(
      new Error('a titleNote implementation that does not honour its own never-throws contract'),
    );

    await expect(service.commit(commitInput(generationRow()))).resolves.toBeUndefined();

    expect(notifications.notify).toHaveBeenCalledWith(
      'notes.note_ready',
      OWNER_ID,
      expect.objectContaining({ title: 'Meeting notes' }),
    );
  });
});

// -----------------------------------------------------------------------------
// recordContext() — the snapshot of what was about to be sent (issue #307)
// -----------------------------------------------------------------------------

describe('recordContext()', () => {
  it('writes systemPrompt, userContent, sourceVersion and a fresh contextCapturedAt', async () => {
    const before = Date.now();
    const { service, prisma } = harness();

    await service.recordContext('gen-1', {
      systemPrompt: 'You write meeting notes.',
      userContent: 'Source material:\nAna: we ship on Friday.',
      sourceVersion: 7,
    });

    expect(prisma.noteGeneration.update).toHaveBeenCalledTimes(1);
    const call = prisma.noteGeneration.update.mock.calls[0][0];

    expect(call.where).toEqual({ id: 'gen-1' });
    expect(call.data.systemPrompt).toBe('You write meeting notes.');
    expect(call.data.userContent).toBe('Source material:\nAna: we ship on Friday.');
    expect(call.data.sourceVersion).toBe(7);
    expect(call.data.contextCapturedAt).toBeInstanceOf(Date);
    expect(call.data.contextCapturedAt.getTime()).toBeGreaterThanOrEqual(before);
  });

  it('writes a `null` sourceVersion for a document source', async () => {
    const { service, prisma } = harness();

    await service.recordContext('gen-1', {
      systemPrompt: 'You write meeting notes.',
      userContent: 'Source material:\nThe extracted contract text.',
      sourceVersion: null,
    });

    expect(prisma.noteGeneration.update.mock.calls[0][0].data.sourceVersion).toBeNull();
  });
});

// -----------------------------------------------------------------------------
// commit() — `bodyFormat` (issue #334)
// -----------------------------------------------------------------------------
//
// Written onto the note in the SAME `note.update` call as `body`/
// `currentVersion` (the transaction's last write), never a separate one — so a
// regenerated note can never end up with a body from one commit and a
// bodyFormat from another. `input.bodyFormat === 'plain_text' ? 'plain_text' :
// 'markdown'` means anything other than the literal string `'plain_text'`
// (including `undefined`/`null`, an omitted field) is written as `'markdown'`
// — the note's bodyFormat is ALWAYS overwritten by this call, it is never
// preserved from the row's prior value.
// -----------------------------------------------------------------------------

describe('commit() — bodyFormat (#334)', () => {
  it('writes bodyFormat onto the note in the same update call as body and currentVersion', async () => {
    const { service, tx } = harness();

    await service.commit({ ...commitInput(generationRow()), bodyFormat: 'plain_text' });

    expect(tx.note.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: NOTE_ID },
        data: expect.objectContaining({
          body: '# Kestrel\n\nWe ship on Friday.',
          currentVersion: 1,
          bodyFormat: 'plain_text',
        }),
      }),
    );
  });

  it('writes `markdown` when bodyFormat is omitted, overwriting whatever the note previously had', async () => {
    const { service, tx } = harness();

    await service.commit(commitInput(generationRow()));

    expect(tx.note.update.mock.calls[0][0].data.bodyFormat).toBe('markdown');
  });

  it('writes `markdown` for any value other than the literal `plain_text`', async () => {
    const { service, tx } = harness();

    await service.commit({ ...commitInput(generationRow()), bodyFormat: 'html' });

    expect(tx.note.update.mock.calls[0][0].data.bodyFormat).toBe('markdown');
  });
});

// -----------------------------------------------------------------------------
// commit() — the VERSION row also carries its own bodyFormat (issue #337)
// -----------------------------------------------------------------------------
//
// So a later restore of THIS version brings the format back with the body,
// even if a subsequent regeneration changed the note's current format.
// -----------------------------------------------------------------------------

describe('commit() — noteVersion.create carries bodyFormat (#337)', () => {
  it('passes bodyFormat: plain_text through to the version row', async () => {
    const { service, tx } = harness();

    await service.commit({ ...commitInput(generationRow()), bodyFormat: 'plain_text' });

    expect(tx.noteVersion.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ bodyFormat: 'plain_text' }),
      }),
    );
  });

  it('defaults the version row to markdown when bodyFormat is absent', async () => {
    const { service, tx } = harness();

    await service.commit(commitInput(generationRow()));

    expect(tx.noteVersion.create.mock.calls[0][0].data.bodyFormat).toBe('markdown');
  });

  it('writes the SAME bodyFormat to both the note and the version, in one commit', async () => {
    const { service, tx } = harness();

    await service.commit({ ...commitInput(generationRow()), bodyFormat: 'plain_text' });

    expect(tx.note.update.mock.calls[0][0].data.bodyFormat).toBe('plain_text');
    expect(tx.noteVersion.create.mock.calls[0][0].data.bodyFormat).toBe('plain_text');
  });
});

// -----------------------------------------------------------------------------
// readPayloadTemplate() — the preview-of-an-unsaved-template seam (issue #334)
// -----------------------------------------------------------------------------

describe('readPayloadTemplate() — bodyFormat', () => {
  const basePayload = (bodyFormat?: unknown) => ({
    template: {
      instructions: 'Write meeting notes.',
      outputFormat: 'Meeting notes',
      ...(bodyFormat === undefined ? {} : { bodyFormat }),
    },
  });

  it('reads `plain_text` through unchanged', () => {
    const result = readPayloadTemplate(basePayload('plain_text'));

    expect(result?.bodyFormat).toBe('plain_text');
  });

  it('maps a payload written before the field existed (no bodyFormat at all) to `markdown`', () => {
    const result = readPayloadTemplate(basePayload());

    expect(result?.bodyFormat).toBe('markdown');
  });

  it('maps anything unrecognised to `markdown`', () => {
    const result = readPayloadTemplate(basePayload('html'));

    expect(result?.bodyFormat).toBe('markdown');
  });
});
