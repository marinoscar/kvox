import { SEARCH_DOC_NOTE } from '../search/indexing/job-types';
import { userDataScopeReaches } from '../user-data/user-data.registries';
import { USER_DATA_PURGE_MAX_BATCHES } from '../user-data/user-data.support';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE, NOTES_MANAGED_BY } from './job-types';
import {
  NOTE_TEMPLATES_USER_DATA_CATEGORY,
  NOTES_USER_DATA_CATEGORY,
  NOTES_USER_DATA_HOOKS,
  NOTES_USER_DATA_SCOPE,
} from './notes.user-data';
import { NotesUserDataHooks } from './notes.user-data.hooks';

// =============================================================================
// Notes and note templates in the Danger Zone (issue #80; moved from the purge
// handler's and the summary service's specs by issue #460)
// =============================================================================
//
//   1. FORCE SEMANTICS: `NotesService.remove`'s "generating" and "referenced by
//      another note" 409s do NOT apply to a bulk deletion — the hook never
//      calls the guarded single-item removal at all.
//   2. ORDER IS NOT STYLISTIC: `source_note_id` is cleared BEFORE the soft
//      delete it unblocks.
//   3. IT REUSES THE PER-ITEM PURGE MACHINERY — it deletes no bytes itself.
//   4. NOTE TEMPLATES are `content`/`everything` only, and go through
//      `NoteTemplatesService.remove`.
// =============================================================================

const USER_ID = 'user-1';

function harness() {
  const prisma = {
    note: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    noteTemplate: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    storageObject: { aggregate: jest.fn().mockResolvedValue({ _sum: { size: null } }) },
    job: { findMany: jest.fn().mockResolvedValue([]) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const notes = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };
  const templates = { remove: jest.fn() };
  // #188: a bulk deletion clears the semantic index for every category it
  // destroys rather than trusting the per-item purge jobs to get there.
  const searchIndex = { forgetOwnerDocuments: jest.fn().mockResolvedValue(0) };

  const hooks = new NotesUserDataHooks(
    prisma as never,
    notes as never,
    templates as never,
    searchIndex as never,
  );

  return { hooks, prisma, notes, templates, searchIndex };
}

// -----------------------------------------------------------------------------
// notes — summary
// -----------------------------------------------------------------------------

describe('NotesUserDataHooks — notes summary', () => {
  it('excludes already soft-deleted rows from the count', async () => {
    const { hooks, prisma } = harness();

    await hooks.summarizeNotes(USER_ID);

    expect(prisma.note.count).toHaveBeenCalledWith({
      where: { ownerId: USER_ID, deletedAt: null },
    });
  });

  it('reports bytes as a decimal STRING, never a number', async () => {
    const { hooks, prisma } = harness();
    prisma.note.count.mockResolvedValue(5);
    prisma.storageObject.aggregate.mockResolvedValue({
      _sum: { size: BigInt('9007199254740993') },
    });

    await expect(hooks.summarizeNotes(USER_ID)).resolves.toEqual({
      count: 5,
      bytes: '9007199254740993',
    });
  });

  it('counts the source document and every export through real foreign keys', async () => {
    const { hooks, prisma } = harness();

    await hooks.summarizeNotes(USER_ID);

    const owned = { ownerId: USER_ID, deletedAt: null };
    expect(prisma.storageObject.aggregate).toHaveBeenCalledWith({
      where: {
        OR: [{ notesAsSourceObject: { some: owned } }, { noteExportFiles: { some: { note: owned } } }],
      },
      _sum: { size: true },
    });
  });

  // The extracted-text sidecar hangs off `storage_objects.metadata`, JSONB with
  // no foreign key — so its ids are collected first and folded into the same
  // `OR`. Leaving it out would understate the figure by the text of every PDF.
  it('folds the extracted-text sidecar objects into the same aggregate, scoped to the notes module', async () => {
    const { hooks, prisma } = harness();
    prisma.note.findMany.mockResolvedValue([
      { sourceObject: { metadata: { extractedObjectId: 'extracted-1' } } },
      { sourceObject: { metadata: {} } },
      { sourceObject: null },
    ]);

    await hooks.summarizeNotes(USER_ID);

    expect(prisma.note.findMany).toHaveBeenCalledWith({
      where: { ownerId: USER_ID, deletedAt: null, sourceObjectId: { not: null } },
      select: { sourceObject: { select: { metadata: true } } },
    });

    const { where } = prisma.storageObject.aggregate.mock.calls[0][0];
    expect(where.OR).toContainEqual({ id: { in: ['extracted-1'] }, managedBy: NOTES_MANAGED_BY });
    expect(where.OR).toHaveLength(3);
  });

  it('omits the sidecar branch entirely when there is none — never an empty `in` list inside an OR', async () => {
    const { hooks, prisma } = harness();

    await hooks.summarizeNotes(USER_ID);

    const { where } = prisma.storageObject.aggregate.mock.calls[0][0];
    expect(where.OR).toHaveLength(2);
  });
});

describe('NotesUserDataHooks — note templates summary', () => {
  it('counts only the caller\'s OWN templates — never the built-ins, which no user can delete', async () => {
    const { hooks, prisma } = harness();
    prisma.noteTemplate.count.mockResolvedValue(4);

    await expect(hooks.summarizeNoteTemplates(USER_ID)).resolves.toEqual({ count: 4 });

    expect(prisma.noteTemplate.count).toHaveBeenCalledWith({ where: { ownerId: USER_ID } });
  });
});

// -----------------------------------------------------------------------------
// notes — force semantics
// -----------------------------------------------------------------------------

describe('NotesUserDataHooks — force semantics override the per-item 409 guards', () => {
  it('deletes a note even while it is "generating" — the bulk path never calls the guarded NotesService.remove', async () => {
    const { hooks, prisma, notes } = harness();

    // `select: { id: true }` is all the query reads — the hook makes no
    // decision on a note's current status at all, which is the mechanism that
    // lets a generating note through: there is no guard to bypass.
    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-generating' }]).mockResolvedValue([]);

    await hooks.purgeNotes(USER_ID);

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['note-generating'] } },
      data: { status: 'deleting', deletedAt: expect.any(Date) },
    });
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-generating');
  });

  it('deletes a note that another note names as its source — clearing the pointer instead of refusing', async () => {
    const { hooks, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-cited' }]).mockResolvedValue([]);

    await hooks.purgeNotes(USER_ID);

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { sourceNoteId: { in: ['note-cited'] } },
      data: { sourceNoteId: null },
    });
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-cited');
  });

  it('clears sourceNoteId before soft-deleting the notes it pointed at', async () => {
    const { hooks, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]).mockResolvedValue([]);

    await hooks.purgeNotes(USER_ID);

    const [clearCall, deleteCall] = prisma.note.updateMany.mock.calls;
    expect(clearCall[0]).toEqual({
      where: { sourceNoteId: { in: ['note-1'] } },
      data: { sourceNoteId: null },
    });
    expect(deleteCall[0]).toEqual({
      where: { id: { in: ['note-1'] } },
      data: { status: 'deleting', deletedAt: expect.any(Date) },
    });

    // Ordering by call order, not merely by presence.
    const clearOrder = prisma.note.updateMany.mock.invocationCallOrder[0];
    const purgeOrder = notes.enqueuePurge.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(purgeOrder);
  });

  it('does NOT catch and silently retry a failure in the reference-clearing step — it fails loudly', async () => {
    const { hooks, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]);

    const fkViolation = new Error('simulated foreign key violation');
    // The FIRST `note.updateMany` call is the sourceNoteId clear.
    prisma.note.updateMany.mockImplementationOnce(() => Promise.reject(fkViolation));

    await expect(hooks.purgeNotes(USER_ID)).rejects.toBe(fkViolation);

    // Nothing downstream ran: no soft delete, no purge enqueue.
    expect(notes.enqueuePurge).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// notes — fan-out, not reimplementation
// -----------------------------------------------------------------------------

describe('NotesUserDataHooks — fans out to the per-item purge machinery, deletes no bytes itself', () => {
  it('skips enqueuing a purge for an id a live purge job already covers', async () => {
    const { hooks, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }, { id: 'note-2' }]).mockResolvedValue([]);
    prisma.job.findMany.mockResolvedValue([{ subjectId: 'note-1' }]);

    await hooks.purgeNotes(USER_ID);

    expect(notes.enqueuePurge).not.toHaveBeenCalledWith('note-1');
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-2');
  });

  it('checks live purge coverage with ONE job.findMany for the whole batch, never per-row', async () => {
    const { hooks, prisma } = harness();

    prisma.note.findMany
      .mockResolvedValueOnce([{ id: 'note-1' }, { id: 'note-2' }, { id: 'note-3' }])
      .mockResolvedValue([]);

    await hooks.purgeNotes(USER_ID);

    expect(prisma.job.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.job.findMany).toHaveBeenCalledWith({
      where: {
        type: NOTE_PURGE_JOB_TYPE,
        subjectType: NOTE_SUBJECT_TYPE,
        subjectId: { in: ['note-1', 'note-2', 'note-3'] },
        status: { in: ['pending', 'running'] },
      },
      select: { subjectId: true },
    });
  });

  it('fails loudly, naming the step, when a selected row never stops matching the query', async () => {
    const { hooks, prisma } = harness();

    // A row that is "selected but unchanged": exactly the shape the real bound
    // exists to catch (a soft-delete that, for whatever reason, never took).
    prisma.note.findMany.mockResolvedValue([{ id: 'note-stuck' }]);

    await expect(hooks.purgeNotes(USER_ID)).rejects.toThrow(
      new RegExp(`did not converge after ${USER_DATA_PURGE_MAX_BATCHES} batches`),
    );

    expect(prisma.note.findMany).toHaveBeenCalledTimes(USER_DATA_PURGE_MAX_BATCHES);
  });
});

describe('NotesUserDataHooks — the semantic index', () => {
  it('forgets the owner\'s note index rows AFTER the delete fan-out', async () => {
    const { hooks, prisma, searchIndex } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]).mockResolvedValue([]);

    await hooks.purgeNotes(USER_ID);

    expect(searchIndex.forgetOwnerDocuments).toHaveBeenCalledWith(USER_ID, SEARCH_DOC_NOTE);
    expect(prisma.note.updateMany.mock.invocationCallOrder[1]).toBeLessThan(
      searchIndex.forgetOwnerDocuments.mock.invocationCallOrder[0],
    );
  });

  it('swallows an index failure — the purge still completes', async () => {
    const { hooks, searchIndex } = harness();
    searchIndex.forgetOwnerDocuments.mockRejectedValue(new Error('index is down'));

    await expect(hooks.purgeNotes(USER_ID)).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// Note templates — content/everything only
// -----------------------------------------------------------------------------

describe('NotesUserDataHooks — note templates', () => {
  it("deletes the caller's own templates through NoteTemplatesService.remove", async () => {
    const { hooks, prisma, templates } = harness();

    prisma.noteTemplate.findMany.mockResolvedValueOnce([{ id: 'template-1' }]).mockResolvedValue([]);
    templates.remove.mockResolvedValue({ id: 'template-1', outcome: 'deleted', noteCount: 0 });

    await hooks.purgeNoteTemplates(USER_ID);

    expect(templates.remove).toHaveBeenCalledWith(USER_ID, 'template-1');
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'user_data:note_templates_deleted',
          meta: { deleted: 1, archived: 0 },
        }),
      }),
    );
  });

  // ⚠ BUILT-INS ARE UNREACHABLE BY CONSTRUCTION: the query filters on
  // `ownerId: userId`, and a built-in has `ownerId IS NULL`.
  it('selects only templates the caller owns', async () => {
    const { hooks, prisma } = harness();

    await hooks.purgeNoteTemplates(USER_ID);

    expect(prisma.noteTemplate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { ownerId: USER_ID } }),
    );
  });

  it('records an ARCHIVED template as skipped so the next page moves past it', async () => {
    const { hooks, prisma, templates } = harness();

    prisma.noteTemplate.findMany
      .mockResolvedValueOnce([{ id: 'template-archived' }])
      .mockResolvedValue([]);
    templates.remove.mockResolvedValue({ id: 'template-archived', outcome: 'archived', noteCount: 2 });

    await hooks.purgeNoteTemplates(USER_ID);

    expect(prisma.noteTemplate.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: { ownerId: USER_ID, id: { notIn: ['template-archived'] } },
      }),
    );
    expect(prisma.auditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ meta: { deleted: 0, archived: 1 } }),
      }),
    );
  });

  it('does not let one damaged template stop the rest', async () => {
    const { hooks, prisma, templates } = harness();

    prisma.noteTemplate.findMany
      .mockResolvedValueOnce([{ id: 'template-bad' }, { id: 'template-ok' }])
      .mockResolvedValue([]);
    templates.remove
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({ id: 'template-ok', outcome: 'deleted', noteCount: 0 });

    await expect(hooks.purgeNoteTemplates(USER_ID)).resolves.toBeUndefined();

    expect(templates.remove).toHaveBeenCalledWith(USER_ID, 'template-ok');
  });
});

// -----------------------------------------------------------------------------
// The declarations
// -----------------------------------------------------------------------------

describe('the `notes` and `noteTemplates` declarations', () => {
  it('registers a narrow `notes` scope that maps to exactly its own category', () => {
    expect(NOTES_USER_DATA_SCOPE).toMatchObject({
      id: 'notes',
      confirmation: 'NOTES',
      categories: ['notes'],
    });
    expect(userDataScopeReaches('notes', 'notes')).toBe(true);
  });

  // ⚠ THE REGRESSION THIS TEST EXISTS TO CATCH: silently reaching note
  // templates from the narrow `notes` scope would empty a user's
  // `/settings/note-templates` page the moment they clicked "Delete notes".
  it('keeps note templates out of the narrow `notes` scope, and in `content`/`everything`', () => {
    expect(userDataScopeReaches('notes', 'noteTemplates')).toBe(false);
    expect(userDataScopeReaches('content', 'noteTemplates')).toBe(true);
    expect(userDataScopeReaches('everything', 'noteTemplates')).toBe(true);
  });

  it('purges notes (40) before transcripts (50), and note templates (60) after both', () => {
    expect(NOTES_USER_DATA_CATEGORY.purge?.order).toBe(40);
    expect(NOTE_TEMPLATES_USER_DATA_CATEGORY.purge?.order).toBe(60);
  });

  it('reports under the keys the Danger Zone has always used', () => {
    expect(NOTES_USER_DATA_CATEGORY.summary?.key).toBe('notes');
    expect(NOTE_TEMPLATES_USER_DATA_CATEGORY.summary?.key).toBe('noteTemplates');
  });

  it('resolves its hooks through the token NotesModule provides', () => {
    for (const category of [NOTES_USER_DATA_CATEGORY, NOTE_TEMPLATES_USER_DATA_CATEGORY]) {
      expect(category.summary?.inject).toBe(NOTES_USER_DATA_HOOKS);
      expect(category.purge?.inject).toBe(NOTES_USER_DATA_HOOKS);
    }
  });

  it('delegates each category\'s hooks to the matching method', async () => {
    const instance = {
      summarizeNotes: jest.fn().mockResolvedValue({}),
      purgeNotes: jest.fn().mockResolvedValue(undefined),
      summarizeNoteTemplates: jest.fn().mockResolvedValue({}),
      purgeNoteTemplates: jest.fn().mockResolvedValue(undefined),
    };
    const ctx = { jobId: 'j', scope: 'content' };

    await NOTES_USER_DATA_CATEGORY.summary?.run(instance, USER_ID);
    await NOTES_USER_DATA_CATEGORY.purge?.run(instance, USER_ID, ctx);
    await NOTE_TEMPLATES_USER_DATA_CATEGORY.summary?.run(instance, USER_ID);
    await NOTE_TEMPLATES_USER_DATA_CATEGORY.purge?.run(instance, USER_ID, ctx);

    for (const method of Object.values(instance)) {
      expect(method).toHaveBeenCalledTimes(1);
      expect(method).toHaveBeenCalledWith(USER_ID);
    }
  });
});
