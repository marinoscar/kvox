import type { Note, NoteGeneration } from '@prisma/client';

import { NoteGenerationService, type GenerationWithNote } from './note-generation.service';
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
  };

  const notifications = { notify: jest.fn().mockResolvedValue(undefined) };
  const config = { get: jest.fn().mockReturnValue('https://app.example.com') };
  const titles = { titleNote: jest.fn().mockResolvedValue('AI-proposed title') };

  const service = new NoteGenerationService(
    prisma as never,
    notifications as never,
    config as never,
    titles as unknown as NoteTitleService,
  );

  return { service, prisma, tx, notifications, config, titles };
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
