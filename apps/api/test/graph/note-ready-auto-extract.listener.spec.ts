import { NOTE_READY_EVENT } from '@marinoscar/kvox-api/notes';

import { NoteReadyAutoExtractListener } from '../../src/graph/extraction/note-ready-auto-extract.listener';

// =============================================================================
// The hand-off from the notes slice's ready event to the graph (issue #495, epic #491)
// =============================================================================
//
// TEMPORARY, like the listener (deleted in #496). What it must keep: the event reaches
// `GraphExtractionService.enqueueForReadyNote(noteId, ownerId)` with the same arguments the
// notes service passed directly before the slice moved, and a failure there is swallowed (the
// note is already committed `ready`).
// =============================================================================

type Handler = (payload: unknown) => Promise<void> | void;

function harness(enqueueForReadyNote: jest.Mock) {
  const handlers = new Map<string, Handler>();
  const events = {
    subscribe: jest.fn((name: string, handler: Handler) => {
      handlers.set(name, handler);
    }),
    emit: jest.fn(),
  };
  const listener = new NoteReadyAutoExtractListener(events as never, { enqueueForReadyNote } as never);

  listener.onModuleInit();

  return { handlers };
}

describe('NoteReadyAutoExtractListener', () => {
  it('subscribes to the ready event and enqueues the extraction with the note and its owner', async () => {
    const enqueueForReadyNote = jest.fn().mockResolvedValue(null);
    const { handlers } = harness(enqueueForReadyNote);

    expect([...handlers.keys()]).toEqual([NOTE_READY_EVENT]);

    await handlers.get(NOTE_READY_EVENT)!({ noteId: 'note-1', ownerId: 'user-1', version: 1 });

    expect(enqueueForReadyNote).toHaveBeenCalledWith('note-1', 'user-1');
  });

  it('swallows a failure: the note is already committed ready', async () => {
    const enqueueForReadyNote = jest.fn().mockRejectedValue(new Error('queue down'));
    const { handlers } = harness(enqueueForReadyNote);

    await expect(
      handlers.get(NOTE_READY_EVENT)!({ noteId: 'note-1', ownerId: 'user-1', version: 1 }),
    ).resolves.toBeUndefined();
  });
});
