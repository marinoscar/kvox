import { JobHandlerRegistry } from '../../jobs/job-handler.registry';
import { NOTE_PURGE_JOB_TYPE, NOTE_SUBJECT_TYPE } from '../../notes/job-types';
import {
  TRANSCRIPT_PURGE_JOB_TYPE,
  TRANSCRIPT_SUBJECT_TYPE,
} from '../../transcripts/job-types';
import { USER_DATA_PURGE_JOB_TYPE, type UserDataScope } from '../job-types';
import {
  USER_DATA_PURGE_MAX_BATCHES,
  UserDataPurgeHandler,
} from './user-data-purge.handler';

// =============================================================================
// `user.data.purge` (issue #80) — the Danger Zone's one job
// =============================================================================
//
// The assertions this file exists for, per the handler's own header:
//
//   1. FORCE SEMANTICS: the three per-item 409 guards
//      (`NotesService.remove`'s "generating"/"referenced-by-another-note"
//      refusals, `TranscriptsService.remove`'s "cited by a note" refusal) do
//      NOT apply to a bulk deletion. This handler never calls the guarded
//      single-item removal path at all — it clears the blocking reference
//      directly and deletes through raw Prisma + the per-item PURGE job.
//   2. ORDER IS NOT STYLISTIC: reference-clearing happens BEFORE the delete
//      it unblocks, credentials go first, note templates are reached only
//      from `content`/`everything`, and nothing here deletes a MANAGED
//      storage object.
//   3. IT REUSES THE PER-ITEM PURGE MACHINERY — it deletes no bytes itself.
//   4. RE-ENTRANCY — every step re-reads what is left rather than carrying a
//      cursor, so a second run over partially-completed state converges.
// =============================================================================

const USER_ID = 'user-1';
const JOB_ID = 'job-1';

interface Harness {
  handler: UserDataPurgeHandler;
  prisma: {
    note: { findMany: jest.Mock; updateMany: jest.Mock };
    transcript: { findMany: jest.Mock; updateMany: jest.Mock };
    noteTemplate: { findMany: jest.Mock };
    storageObject: { findMany: jest.Mock };
    job: { findMany: jest.Mock };
    auditEvent: { create: jest.Mock };
  };
  notes: { enqueuePurge: jest.Mock };
  templates: { remove: jest.Mock };
  pipeline: { enqueuePurge: jest.Mock };
  objects: { delete: jest.Mock };
  pat: { revokeAllForUser: jest.Mock };
  aiCredentials: { removeAll: jest.Mock };
  searchIndex: { forget: jest.Mock; forgetOwnerDocuments: jest.Mock };
  userSettings: { patchSettings: jest.Mock };
  registry: JobHandlerRegistry;
}

function harness(): Harness {
  const prisma = {
    note: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    transcript: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    noteTemplate: { findMany: jest.fn().mockResolvedValue([]) },
    storageObject: { findMany: jest.fn().mockResolvedValue([]) },
    // The `enqueuePurges` live-job dedup check — "nothing already covers
    // this id" unless a test says otherwise.
    job: { findMany: jest.fn().mockResolvedValue([]) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  const notes = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };
  const templates = { remove: jest.fn() };
  const pipeline = { enqueuePurge: jest.fn().mockResolvedValue(undefined) };
  const objects = { delete: jest.fn().mockResolvedValue(undefined) };
  const pat = { revokeAllForUser: jest.fn().mockResolvedValue(0) };
  const aiCredentials = { removeAll: jest.fn().mockResolvedValue(0) };
  // #188: a bulk deletion clears the semantic index for every category it
  // destroys rather than trusting the per-item purge jobs to get there.
  const searchIndex = {
    forget: jest.fn().mockResolvedValue(undefined),
    forgetOwnerDocuments: jest.fn().mockResolvedValue(0),
  };
  // Epic #271: `everything` clears the `onboarding` namespace through the
  // service that owns the settings row, never through a hand-written JSONB
  // edit. The mock is the service, so the assertions below are about the
  // REQUEST this handler makes — which namespace, and only which namespace.
  const userSettings = { patchSettings: jest.fn().mockResolvedValue({}) };
  const registry = new JobHandlerRegistry();

  const handler = new UserDataPurgeHandler(
    registry,
    prisma as never,
    notes as never,
    templates as never,
    pipeline as never,
    objects as never,
    pat as never,
    aiCredentials as never,
    searchIndex as never,
    userSettings as never,
  );

  return {
    handler,
    prisma,
    notes,
    templates,
    pipeline,
    objects,
    pat,
    aiCredentials,
    searchIndex,
    userSettings,
    registry,
  };
}

const job = (scope: UserDataScope, overrides: Record<string, unknown> = {}) =>
  ({ id: JOB_ID, payload: { userId: USER_ID, scope, ...overrides } }) as never;

// -----------------------------------------------------------------------------
// Registration, profile, and permanent server-only eligibility
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — registration and profile', () => {
  it('registers itself under the permanent type string', () => {
    const { handler, registry } = harness();

    handler.onModuleInit();

    expect(handler.type).toBe(USER_DATA_PURGE_JOB_TYPE);
    expect(registry.get(USER_DATA_PURGE_JOB_TYPE)).toBe(handler);
  });

  it('declares exactly one attempt and a bounded runtime — never auto-retried', () => {
    const { handler } = harness();

    expect(handler.profile).toEqual({
      maxRuntimeMs: 30 * 60_000,
      maxAttempts: 1,
    });
    expect(Object.keys(handler.profile ?? {}).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);
  });

  it('is SERVER-ONLY PERMANENTLY — declares neither node member, so no node can ever claim it', () => {
    const { handler, registry } = harness();

    handler.onModuleInit();

    const asRecord = handler as unknown as Record<string, unknown>;
    expect(asRecord.nodeResultSchema).toBeUndefined();
    expect(asRecord.persistNodeResult).toBeUndefined();

    expect(registry.serverOnlyTypes()).toContain(USER_DATA_PURGE_JOB_TYPE);
    expect(registry.types().filter((t) => !registry.serverOnlyTypes().includes(t))).not.toContain(
      USER_DATA_PURGE_JOB_TYPE,
    );
  });
});

// -----------------------------------------------------------------------------
// An unreadable payload is a no-op, not a failure
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — an unreadable payload', () => {
  it.each([
    ['null', null],
    ['a string', 'user-1'],
    ['an unknown scope', { userId: USER_ID, scope: 'literally-everything' }],
    ['a missing userId', { scope: 'everything' }],
  ])('returns successfully and touches nothing for a payload that is %s', async (_label, payload) => {
    const { handler, prisma } = harness();

    await expect(handler.process({ id: JOB_ID, payload } as never)).resolves.toBeUndefined();

    expect(prisma.note.findMany).not.toHaveBeenCalled();
    expect(prisma.transcript.findMany).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// Force semantics — the per-item 409 guards do not apply here
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — force semantics override the per-item 409 guards', () => {
  it('deletes a note even while it is "generating" — the bulk path never calls the guarded NotesService.remove', async () => {
    const { handler, prisma, notes } = harness();

    // `select: { id: true }` is all the query reads — the handler makes no
    // decision on a note's current status at all, which is the mechanism
    // that lets a generating note through: there is no guard to bypass.
    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-generating' }]).mockResolvedValue([]);

    await handler.process(job('notes'));

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['note-generating'] } },
      data: { status: 'deleting', deletedAt: expect.any(Date) },
    });
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-generating');
  });

  it('deletes a note that another note names as its source — clearing the pointer instead of refusing', async () => {
    const { handler, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-cited' }]).mockResolvedValue([]);

    await handler.process(job('notes'));

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { sourceNoteId: { in: ['note-cited'] } },
      data: { sourceNoteId: null },
    });
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-cited');
  });

  it('deletes a transcript that a note cites — clearing sourceTranscriptId instead of refusing', async () => {
    const { handler, prisma, pipeline } = harness();

    prisma.transcript.findMany
      .mockResolvedValueOnce([{ id: 'transcript-cited' }])
      .mockResolvedValue([]);

    await handler.process(job('transcripts'));

    expect(prisma.note.updateMany).toHaveBeenCalledWith({
      where: { sourceTranscriptId: { in: ['transcript-cited'] } },
      data: { sourceTranscriptId: null },
    });
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-cited');
  });
});

// -----------------------------------------------------------------------------
// FK clearing happens BEFORE the delete — ordering, not a rescue
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — reference clearing is ordered before the delete, not a rescue', () => {
  it('clears sourceNoteId before soft-deleting the notes it pointed at', async () => {
    const { handler, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]).mockResolvedValue([]);

    await handler.process(job('notes'));

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

  it('clears sourceTranscriptId before soft-deleting the transcripts it pointed at', async () => {
    const { handler, prisma, pipeline } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await handler.process(job('transcripts'));

    const noteClearOrder = prisma.note.updateMany.mock.invocationCallOrder[0];
    const transcriptUpdateOrder = prisma.transcript.updateMany.mock.invocationCallOrder[0];
    const purgeOrder = pipeline.enqueuePurge.mock.invocationCallOrder[0];

    expect(noteClearOrder).toBeLessThan(transcriptUpdateOrder);
    expect(transcriptUpdateOrder).toBeLessThan(purgeOrder);
  });

  it('does NOT catch and silently retry a failure in the reference-clearing step — it fails loudly', async () => {
    const { handler, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]);

    const fkViolation = new Error('simulated foreign key violation');
    // The FIRST `note.updateMany` call in `deleteNotes` is the sourceNoteId
    // clear — see the ordering test above.
    prisma.note.updateMany.mockImplementationOnce(() => Promise.reject(fkViolation));

    await expect(handler.process(job('notes'))).rejects.toBe(fkViolation);

    // Nothing downstream ran: no soft delete, no purge enqueue. A
    // catch-and-retry would have swallowed this and pressed on.
    expect(notes.enqueuePurge).not.toHaveBeenCalled();
  });
});

// -----------------------------------------------------------------------------
// sourceTranscriptId is cleared on OTHER users' notes too
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — a shared transcript can be cited by a note this user does not own', () => {
  it('clears sourceTranscriptId with no ownerId scoping at all', async () => {
    const { handler, prisma } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await handler.process(job('transcripts'));

    const clearCall = prisma.note.updateMany.mock.calls.find(
      ([args]: [{ where: Record<string, unknown> }]) => 'sourceTranscriptId' in args.where,
    );

    expect(clearCall).toBeDefined();
    expect(clearCall[0]).toEqual({
      where: { sourceTranscriptId: { in: ['transcript-1'] } },
      data: { sourceTranscriptId: null },
    });
    // No `ownerId` restricting this to the deleting user's own notes — a
    // "fix" that added one would leave a stranger's note pointing at a
    // transcript row that is about to stop existing.
    expect(clearCall[0].where).not.toHaveProperty('ownerId');
  });
});

// -----------------------------------------------------------------------------
// Step ordering across the whole run
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — step ordering for scope "everything"', () => {
  it('runs credentials, then notes, then transcripts, then note templates, then unmanaged files, then the onboarding reset', async () => {
    const { handler, prisma, aiCredentials, userSettings } = harness();

    const order: string[] = [];
    aiCredentials.removeAll.mockImplementation(async () => {
      order.push('credentials');
      return 0;
    });
    prisma.note.findMany.mockImplementation(async () => {
      order.push('notes');
      return [];
    });
    prisma.transcript.findMany.mockImplementation(async () => {
      order.push('transcripts');
      return [];
    });
    prisma.noteTemplate.findMany.mockImplementation(async () => {
      order.push('noteTemplates');
      return [];
    });
    prisma.storageObject.findMany.mockImplementation(async () => {
      order.push('files');
      return [];
    });
    userSettings.patchSettings.mockImplementation(async () => {
      order.push('onboarding');
      return {};
    });

    await handler.process(job('everything'));

    // ⚠ ONBOARDING IS LAST, AND THAT POSITION IS THE ASSERTION. Resetting
    // first-run state tells the user "you are starting over"; made before the
    // destruction it narrates, a later step throwing would leave them reading
    // a fresh-start banner over a library that is still half there.
    expect(order).toEqual([
      'credentials',
      'notes',
      'transcripts',
      'noteTemplates',
      'files',
      'onboarding',
    ]);
  });
});

// -----------------------------------------------------------------------------
// Note templates — content/everything only
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — note templates are reached only from content/everything', () => {
  it('never queries note templates for the narrow "notes" scope', async () => {
    const { handler, prisma } = harness();

    await handler.process(job('notes'));

    expect(prisma.noteTemplate.findMany).not.toHaveBeenCalled();
  });

  it('deletes the caller\'s own templates through NoteTemplatesService.remove for scope "content"', async () => {
    const { handler, prisma, templates } = harness();

    prisma.noteTemplate.findMany
      .mockResolvedValueOnce([{ id: 'template-1' }])
      .mockResolvedValue([]);
    templates.remove.mockResolvedValue({ id: 'template-1', outcome: 'deleted', noteCount: 0 });

    await handler.process(job('content'));

    expect(templates.remove).toHaveBeenCalledWith(USER_ID, 'template-1');
  });
});

// -----------------------------------------------------------------------------
// Unmanaged storage objects only
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — only unmanaged storage objects go through this handler', () => {
  it('selects storage objects with managedBy: null, owned by the caller — never a module-managed one', async () => {
    const { handler, prisma } = harness();

    await handler.process(job('files'));

    expect(prisma.storageObject.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uploadedById: USER_ID, managedBy: null }),
      }),
    );
  });

  it('deletes through ObjectsService.delete, the same path per-item deletes already use', async () => {
    const { handler, prisma, objects } = harness();

    prisma.storageObject.findMany
      .mockResolvedValueOnce([{ id: 'object-1' }])
      .mockResolvedValue([]);

    await handler.process(job('files'));

    expect(objects.delete).toHaveBeenCalledWith('object-1', USER_ID);
  });
});

// -----------------------------------------------------------------------------
// Fan-out, not reimplementation
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — fans out to the per-item purge machinery, deletes no bytes itself', () => {
  it('hands notes to NotesService.enqueuePurge and transcripts to TranscriptPipelineService.enqueuePurge', async () => {
    const { handler, prisma, notes, pipeline } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }]).mockResolvedValue([]);
    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await handler.process(job('content'));

    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-1');
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-1');
  });

  it('skips enqueuing a purge for an id a live purge job already covers', async () => {
    const { handler, prisma, notes } = harness();

    prisma.note.findMany.mockResolvedValueOnce([{ id: 'note-1' }, { id: 'note-2' }]).mockResolvedValue([]);
    prisma.job.findMany.mockResolvedValue([{ subjectId: 'note-1' }]);

    await handler.process(job('notes'));

    expect(notes.enqueuePurge).not.toHaveBeenCalledWith('note-1');
    expect(notes.enqueuePurge).toHaveBeenCalledWith('note-2');
  });

  it('checks live purge coverage with ONE job.findMany for the whole batch, never per-row', async () => {
    const { handler, prisma } = harness();

    prisma.note.findMany
      .mockResolvedValueOnce([{ id: 'note-1' }, { id: 'note-2' }, { id: 'note-3' }])
      .mockResolvedValue([]);

    await handler.process(job('notes'));

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

  it('checks transcript purge coverage against TRANSCRIPT_PURGE_JOB_TYPE / TRANSCRIPT_SUBJECT_TYPE', async () => {
    const { handler, prisma } = harness();

    prisma.transcript.findMany.mockResolvedValueOnce([{ id: 'transcript-1' }]).mockResolvedValue([]);

    await handler.process(job('transcripts'));

    expect(prisma.job.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          type: TRANSCRIPT_PURGE_JOB_TYPE,
          subjectType: TRANSCRIPT_SUBJECT_TYPE,
        }),
      }),
    );
  });
});

// -----------------------------------------------------------------------------
// Credentials — everything only, the one line the composites differ on
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — credentials are destroyed under "everything" only', () => {
  it('revokes AI keys and access tokens for scope "everything"', async () => {
    const { handler, aiCredentials, pat } = harness();

    await handler.process(job('everything'));

    expect(aiCredentials.removeAll).toHaveBeenCalledWith(USER_ID);
    expect(pat.revokeAllForUser).toHaveBeenCalledWith(USER_ID);
  });

  it('does NOT touch credentials for scope "content" — the one line the two composites differ on', async () => {
    const { handler, aiCredentials, pat } = harness();

    await handler.process(job('content'));

    expect(aiCredentials.removeAll).not.toHaveBeenCalled();
    expect(pat.revokeAllForUser).not.toHaveBeenCalled();
  });

  it.each<UserDataScope>(['transcripts', 'notes', 'files'])(
    'does NOT touch credentials for the narrow scope "%s"',
    async (scope) => {
      const { handler, aiCredentials, pat } = harness();

      await handler.process(job(scope));

      expect(aiCredentials.removeAll).not.toHaveBeenCalled();
      expect(pat.revokeAllForUser).not.toHaveBeenCalled();
    },
  );
});

// -----------------------------------------------------------------------------
// Onboarding state — everything only, and exactly one namespace
// -----------------------------------------------------------------------------
//
// Epic #271 put first-run INTENT in the `onboarding` user-settings namespace:
// `welcomeSeenAt`, `dismissedAt`, `adminDismissedAt`, `skipped[]`. The
// checklist itself is derived live and regresses on its own after a wipe — no
// transcripts and no AI key put its required steps back outstanding — but the
// SURVIVING intent then hides it, because `chooseBannerAudience` bails on
// `dismissedAt` and `FirstRunWelcomeDialog`'s `due` gate bails on
// `welcomeSeenAt`. So `everything` clears it, and nothing else does.
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — onboarding state is reset under "everything" only', () => {
  it('clears the onboarding namespace for scope "everything"', async () => {
    const { handler, userSettings } = harness();

    await handler.process(job('everything'));

    expect(userSettings.patchSettings).toHaveBeenCalledTimes(1);
    expect(userSettings.patchSettings).toHaveBeenCalledWith(USER_ID, { onboarding: null });
  });

  // ⚠ THE ASSERTION THAT MATTERS MOST IN THIS FILE'S NEWEST SECTION: the patch
  // body is EXACTLY `{ onboarding: null }` and carries no other key. A widening
  // to a whole-settings reset — `{ theme: 'system', navigation: null, ... }`, or
  // a `replaceSettings(userId, DEFAULT_USER_SETTINGS)` — is a one-word change
  // away and would be invisible in every other test here, because nothing else
  // in this handler reads settings. It would also be wrong in a way the user
  // pays for: deleting your data is not "reset my preferences", and the account
  // survives, so the person is still signed in looking at a screen that
  // silently changed theme, navigation and notification choices they never
  // touched.
  it('sends EXACTLY { onboarding: null } — never a whole-settings reset', async () => {
    const { handler, userSettings } = harness();

    await handler.process(job('everything'));

    const [userId, patch] = userSettings.patchSettings.mock.calls[0];

    expect(userId).toBe(USER_ID);
    expect(patch).toEqual({ onboarding: null });
    expect(Object.keys(patch as Record<string, unknown>)).toEqual(['onboarding']);

    for (const survivor of ['theme', 'profile', 'navigation', 'notifications', 'dataTables']) {
      expect(patch as Record<string, unknown>).not.toHaveProperty(survivor);
    }
  });

  // ⚠ NO `If-Match`. `patchSettings`' third argument is an optimistic
  // concurrency expectation, and a background job queued minutes ago has none
  // to state. Passing one would turn a user who toggled their theme mid-run
  // into a `failed` purge.
  it('passes no expected version — a server-side reset states no concurrency expectation', async () => {
    const { handler, userSettings } = harness();

    await handler.process(job('everything'));

    expect(userSettings.patchSettings.mock.calls[0]).toHaveLength(2);
  });

  it('does NOT reset onboarding for scope "content" — deleting your content is not starting over', async () => {
    const { handler, userSettings } = harness();

    await handler.process(job('content'));

    expect(userSettings.patchSettings).not.toHaveBeenCalled();
  });

  it.each<UserDataScope>(['transcripts', 'notes', 'files'])(
    'does NOT reset onboarding for the narrow scope "%s"',
    async (scope) => {
      const { handler, userSettings } = harness();

      await handler.process(job(scope));

      expect(userSettings.patchSettings).not.toHaveBeenCalled();
    },
  );

  // A payload this build cannot read names no user and no scope, so the
  // handler returns before any step — including this one.
  it('touches settings for no scope at all when the payload is unreadable', async () => {
    const { handler, userSettings } = harness();

    await handler.process({ id: JOB_ID, payload: { userId: USER_ID } } as never);

    expect(userSettings.patchSettings).not.toHaveBeenCalled();
  });

  // Idempotent by construction: clearing an already-absent namespace stores
  // the same absence, so a re-requested deletion after a partial run needs no
  // special case here.
  it('is idempotent — a second run issues the same clear and does not throw', async () => {
    const { handler, userSettings } = harness();

    await handler.process(job('everything'));
    await handler.process(job('everything'));

    expect(userSettings.patchSettings).toHaveBeenCalledTimes(2);
    expect(userSettings.patchSettings).toHaveBeenNthCalledWith(2, USER_ID, { onboarding: null });
  });

  // ⚠ THROWS RATHER THAN SWALLOWING, unlike `forgetFromSearchIndex`. That one
  // runs BETWEEN destructive steps, where failing would leave the user with a
  // `failed` row and no idea which half ran. This one runs last, after every
  // destructive step has completed and audited, so a failure is unambiguous:
  // everything was deleted, the reset did not happen. Reporting it honestly
  // costs a re-request the handler is re-entrant enough to satisfy cheaply;
  // swallowing would cost onboarding state surviving a full wipe with nothing
  // anywhere saying so — the exact bug this step was added to fix.
  it('fails the job loudly when the settings patch fails — it does not swallow', async () => {
    const { handler, userSettings } = harness();

    userSettings.patchSettings.mockRejectedValue(new Error('settings row is on fire'));

    await expect(handler.process(job('everything'))).rejects.toThrow('settings row is on fire');
  });
});

// -----------------------------------------------------------------------------
// Re-entrancy
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — re-entrancy', () => {
  it('running process() twice over partially-completed state finishes the work and does not throw', async () => {
    const { handler, prisma, pipeline } = harness();

    // Notes are already fully purged from an earlier partial run.
    prisma.note.findMany.mockResolvedValue([]);

    // One transcript remains from that earlier run; once handled it is gone.
    let transcriptsRemaining = [{ id: 'transcript-straggler' }];
    prisma.transcript.findMany.mockImplementation(async () => {
      const batch = transcriptsRemaining;
      transcriptsRemaining = [];
      return batch;
    });

    await expect(handler.process(job('content'))).resolves.toBeUndefined();
    expect(pipeline.enqueuePurge).toHaveBeenCalledWith('transcript-straggler');

    // Second run: everything the database can now see is already gone.
    await expect(handler.process(job('content'))).resolves.toBeUndefined();
    // Not re-enqueued a second time.
    expect(pipeline.enqueuePurge).toHaveBeenCalledTimes(1);
  });

  it('tolerates a row that has already vanished by the time an unmanaged object delete runs', async () => {
    const { handler, prisma, objects } = harness();

    prisma.storageObject.findMany.mockResolvedValueOnce([{ id: 'object-gone' }]).mockResolvedValue([]);
    objects.delete.mockRejectedValueOnce(new Error('object not found'));

    // The per-row try/catch in `deleteUnmanagedObjects` tolerates this and
    // still completes the job rather than failing the whole run over one
    // already-gone row.
    await expect(handler.process(job('files'))).resolves.toBeUndefined();
  });
});

// -----------------------------------------------------------------------------
// The batch loop is bounded
// -----------------------------------------------------------------------------

describe('UserDataPurgeHandler — the batch loop is bounded', () => {
  it('fails loudly, naming the step, when a selected row never stops matching the query', async () => {
    const { handler, prisma } = harness();

    // A row that is "selected but unchanged": the mock always returns the
    // same page, exactly the shape the real bound exists to catch (a
    // soft-delete that, for whatever reason, never took).
    prisma.note.findMany.mockResolvedValue([{ id: 'note-stuck' }]);

    await expect(handler.process(job('notes'))).rejects.toThrow(
      new RegExp(`did not converge after ${USER_DATA_PURGE_MAX_BATCHES} batches`),
    );

    expect(prisma.note.findMany).toHaveBeenCalledTimes(USER_DATA_PURGE_MAX_BATCHES);
  });
});
