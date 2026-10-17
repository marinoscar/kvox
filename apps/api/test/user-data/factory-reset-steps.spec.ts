// =============================================================================
// This app's admin factory reset steps (issue #562)
// =============================================================================
//
// Pure: a recording transaction stands in for Prisma, so the ORDER of the deletes
// (children before parents, the Restrict columns cleared first, evidence and every
// graph subject in the one transaction the deferred no-orphans trigger needs), the
// registration order and the storage sweep's paging and failure handling are
// pinned here. `factory-reset.db.spec.ts` runs the real handler against Postgres.
// =============================================================================

import '../../src/kvox.manifest';
import '../../src/app-registrations/registrations';
import '../../src/platform/storage/storage-key-prefix.manifest';
import '../../src/platform/user-data/user-data.manifest';

import {
  UserDataPlanService,
  composedSchemaDatamodel,
  factoryResetDeletedLines,
  factoryResetStepRegistry,
  userDataModelRegistry,
} from '@marinoscar/platform-api/user-data';
import { NOTE_BUILTIN_TEMPLATES } from '@marinoscar/kvox-api/notes/templates';

import { KVOX_CONTENT_STEP, KVOX_NOTE_TEMPLATES_STEP } from '../../src/platform/user-data/factory-reset.steps';
import { KVOX_STORAGE_STEP, bindKvoxFactoryResetDeps } from '../../src/kvox-objects/factory-reset-storage.step';

const CTX = { actorUserId: '11111111-1111-4111-8111-111111111111', jobId: '22222222-2222-4222-8222-222222222222' };

/** A transaction that records `<model>.<method>` and answers counts. */
function recordingTx(counts: Record<string, number> = {}) {
  const calls: Array<{ call: string; args: any }> = [];
  const tx = new Proxy(
    {},
    {
      get: (_target, model: string) =>
        new Proxy(
          {},
          {
            get: (_t, method: string) => async (args?: any) => {
              calls.push({ call: `${model}.${method}`, args });

              return method === 'count' ? (counts[model] ?? 0) : { count: counts[model] ?? 0 };
            },
          },
        ),
    },
  );
  const order = (call: string) => calls.findIndex((entry) => entry.call === call);

  return { tx, calls, order, names: () => calls.map((entry) => entry.call) };
}

describe('registration', () => {
  it('registers the three steps ahead of the platform’s, in the phases the handler runs them', () => {
    const steps = factoryResetStepRegistry.list();
    const ids = steps.map((step) => step.id);

    expect(ids.slice(0, 3)).toEqual(['kvox.content', 'kvox.storage-objects', 'kvox.note-templates']);
    expect(ids).toEqual(expect.arrayContaining(['platform.broadcasts', 'platform.allowlist']));
    expect(steps.find((step) => step.id === 'kvox.content')?.phase).toBe('before-users');
    expect(steps.find((step) => step.id === 'kvox.storage-objects')?.phase).toBe('deployment');
    expect(steps.find((step) => step.id === 'kvox.note-templates')?.phase).toBe('deployment');
  });

  it('adds one line to the page’s "Deleted" list, for the content only', () => {
    const lines = factoryResetDeletedLines();

    expect(lines).toContain(KVOX_CONTENT_STEP.summary);
    // The built-in "Every stored file except database backups" already covers the sweep.
    expect(KVOX_STORAGE_STEP.summary).toBeUndefined();
    expect(lines).toContain('Every stored file except database backups');
  });

  it('keeps `storage_objects` out of the reset’s org-data step: the sweep owns the table', () => {
    const plans = new UserDataPlanService({ datamodel: composedSchemaDatamodel(__dirname) } as never);

    expect(userDataModelRegistry.get('StorageObject')?.factoryReset).toBe('keep');
    expect(plans.org().steps.find((step) => step.model === 'StorageObject')).toMatchObject({ factoryReset: 'keep' });
    // The reason a step is needed at all: the platform sees no storage plan, so its own
    // storage step (step 7) never runs.
    expect(plans.user().storage).toBeUndefined();
  });
});

describe('kvox.content', () => {
  it('wipes the search index, the graph, the notes and the transcripts of every user', async () => {
    const { tx, names } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    for (const model of [
      'searchChunk',
      'searchIndexState',
      'kgEvidence',
      'kgEntity',
      'kgRelation',
      'kgItem',
      'kgExport',
      'note',
      'noteExport',
      'noteVersion',
      'noteGeneration',
      'noteTemplate',
      'transcript',
      'transcriptSegment',
      'transcriptSpeaker',
      'transcriptVersion',
      'transcriptExport',
    ]) {
      expect(names()).toContain(`${model}.deleteMany`);
    }
  });

  it('deletes every holder of a Restrict reference before its target, and children before parents', async () => {
    const { tx, order } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    const before = (first: string, second: string) => expect(order(first)).toBeLessThan(order(second));

    // A segment Restricts its speaker; the speaker cascades from the transcript.
    before('transcriptSegment.deleteMany', 'transcriptSpeaker.deleteMany');
    before('transcriptSpeaker.deleteMany', 'transcript.deleteMany');
    before('transcriptExport.deleteMany', 'transcript.deleteMany');
    before('transcriptVersion.deleteMany', 'transcript.deleteMany');
    // A note Restricts its source note and its source transcript: cleared, then deleted.
    before('note.updateMany', 'note.deleteMany');
    before('note.deleteMany', 'transcript.deleteMany');
    before('noteExport.deleteMany', 'note.deleteMany');
    // The custom templates go after the notes that named them.
    before('note.deleteMany', 'noteTemplate.deleteMany');
    // The graph points at transcripts, segments and notes (SetNull / Cascade), so it goes first.
    before('kgEntity.deleteMany', 'note.deleteMany');
    before('kgEntity.deleteMany', 'transcript.deleteMany');
    // Evidence after (or with) its subjects, the graph spec's rule.
    for (const subject of ['kgEntity', 'kgRelation', 'kgItem']) before(`${subject}.deleteMany`, 'kgEvidence.deleteMany');
  });

  it('clears the note references on every note, whoever owns it', async () => {
    const { tx, calls } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    const update = calls.find((entry) => entry.call === 'note.updateMany');

    expect(update?.args).toEqual({
      where: { OR: [{ sourceNoteId: { not: null } }, { sourceTranscriptId: { not: null } }] },
      data: { sourceNoteId: null, sourceTranscriptId: null },
    });
  });

  it('spares the built-in note templates (they have no owner)', async () => {
    const { tx, calls } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    const templates = calls.find((entry) => entry.call === 'noteTemplate.deleteMany');

    expect(templates?.args).toEqual({ where: { ownerId: { not: null } } });
  });

  it('deletes the graph’s evidence AND its subjects, so the deferred no-orphans trigger finds nothing to refuse', async () => {
    const { tx, calls } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    // Each is an unfiltered whole-table delete in the SAME transaction: at COMMIT the trigger
    // re-reads each subject, finds no row, and passes.
    for (const model of ['kgEvidence', 'kgEntity', 'kgRelation', 'kgItem']) {
      expect(calls.find((entry) => entry.call === `${model}.deleteMany`)?.args).toEqual({ where: {} });
    }
  });

  it('reports what it deleted, and the vendor copies it cannot reach', async () => {
    const { tx } = recordingTx({ transcript: 3, note: 5, kgEntity: 7, searchChunk: 11 });

    const counts = await KVOX_CONTENT_STEP.run(tx, CTX);

    expect(counts).toMatchObject({ transcripts: 3, notes: 5, graphEntities: 7, searchChunks: 11 });
    // `transcript.count` answers the same 3: the number of transcripts still held by the provider.
    expect(counts.providerCopiesRemaining).toBe(3);
  });

  it('counts only transcripts whose provider copy was never deleted', async () => {
    const { tx, calls } = recordingTx();

    await KVOX_CONTENT_STEP.run(tx, CTX);

    expect(calls.find((entry) => entry.call === 'transcript.count')?.args).toEqual({
      where: { providerJobId: { not: null }, remoteDeletedAt: null },
    });
  });
});

describe('kvox.storage-objects', () => {
  afterEach(() => bindKvoxFactoryResetDeps(undefined));

  /** An in-memory `storage_objects` honouring the paging cursor and `id in`, recording the first `where`. */
  function fakeSystem(rows: Array<{ id: string; storageKey: string }>) {
    const wheres: any[] = [];
    const table = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
    const system = {
      storageObject: {
        findMany: async (args: any) => {
          wheres.push(args.where);

          let result = table;

          if (args.where.id?.gt) result = result.filter((row) => row.id > args.where.id.gt);
          if (args.where.id?.in) result = result.filter((row) => args.where.id.in.includes(row.id));

          return result.slice(0, args.take ?? result.length).map((row) => ({ ...row, s3UploadId: null }));
        },
        deleteMany: async (args: any) => {
          const before = table.length;

          for (const id of args.where.id.in ?? [args.where.id]) {
            const at = table.findIndex((row) => row.id === id);

            if (at >= 0) table.splice(at, 1);
          }

          return { count: before - table.length };
        },
      },
    };

    return { system, table, wheres };
  }

  it('refuses to run unbound, so a missing binding is loud rather than a silent no-op', async () => {
    await expect(KVOX_STORAGE_STEP.run({}, CTX)).rejects.toThrow(/no ports/);
  });

  it('deletes every object’s bytes and then its row, outside the surviving prefixes', async () => {
    const rows = ['a', 'b', 'c'].map((id) => ({ id, storageKey: `transcripts/${id}` }));
    const { system, table, wheres } = fakeSystem(rows);
    const deleted: string[] = [];

    bindKvoxFactoryResetDeps({
      db: { system: () => system } as never,
      storage: { delete: async (key: string) => void deleted.push(key), abortMultipartUpload: async () => undefined },
    });

    const counts = await KVOX_STORAGE_STEP.run({}, CTX);

    expect(counts).toEqual({ storageObjectsDeleted: 3, storageObjectsFailed: 0 });
    expect(deleted.sort()).toEqual(['transcripts/a', 'transcripts/b', 'transcripts/c']);
    expect(table).toHaveLength(0);
    // The database backups are the one surviving prefix.
    expect(wheres[0]).toEqual({ NOT: { OR: [{ storageKey: { startsWith: 'database-backups/' } }] } });
  });

  it('keeps the row of an object the provider refuses and counts it, never throwing', async () => {
    const rows = ['a', 'b'].map((id) => ({ id, storageKey: `notes/${id}` }));
    const { system, table } = fakeSystem(rows);

    bindKvoxFactoryResetDeps({
      db: { system: () => system } as never,
      storage: {
        delete: async (key: string) => {
          if (key === 'notes/b') throw new Error('refused');
        },
        abortMultipartUpload: async () => undefined,
      },
    });

    const counts = await KVOX_STORAGE_STEP.run({}, CTX);

    expect(counts).toEqual({ storageObjectsDeleted: 1, storageObjectsFailed: 1 });
    expect(table.map((row) => row.id)).toEqual(['b']);
  });

  it('pages by id and finishes a table larger than one page', async () => {
    const rows = Array.from({ length: 2300 }, (_, i) => ({ id: String(i).padStart(5, '0'), storageKey: `graph/${i}` }));
    const { system, table } = fakeSystem(rows);

    bindKvoxFactoryResetDeps({
      db: { system: () => system } as never,
      storage: { delete: async () => undefined, abortMultipartUpload: async () => undefined },
    });

    const counts = await KVOX_STORAGE_STEP.run({}, CTX);

    expect(counts).toEqual({ storageObjectsDeleted: 2300, storageObjectsFailed: 0 });
    expect(table).toHaveLength(0);
  });
});

describe('kvox.note-templates', () => {
  it('re-seeds the built-in templates the platform’s owner-less sweep deleted', async () => {
    const upserted: string[] = [];
    const tx = {
      noteTemplate: {
        findMany: async () => [],
        upsert: async (args: any) => void upserted.push(args.where.id),
      },
    };

    const counts = await KVOX_NOTE_TEMPLATES_STEP.run(tx, CTX);

    expect(upserted.sort()).toEqual(NOTE_BUILTIN_TEMPLATES.map((template) => template.id).sort());
    expect(counts).toEqual({ builtInTemplatesRestored: NOTE_BUILTIN_TEMPLATES.length, builtInTemplatesPresent: 0 });
  });
});
