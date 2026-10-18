// =============================================================================
// This app's organization offboarding steps (issue #568)
// =============================================================================
//
// Pure: a recording transaction stands in for Prisma. Pinned here:
//
//   * every statement of `kvox.org.content` is scoped to the offboarded organization
//     (an `orgId`, a relation filter on it, or the ids of that organization's transcripts);
//   * the order of the deletes (Restrict holders before their targets);
//   * the skip cases of `runKvoxOrgOffboardingSteps` and its throw after the whole sweep;
//   * the wrapper's idempotency and ordering, and the binding's skip without a handler;
//   * the organization storage sweep: other organizations and the surviving prefix are untouched.
//
// `org-offboarding.db.spec.ts` runs the real platform handler against Postgres.
// =============================================================================

import '../../src/platform/storage/storage-key-prefix.manifest';

import { Logger } from '@nestjs/common';

import {
  KvoxOrgOffboardBinding,
  runKvoxOrgContent,
  runKvoxOrgOffboardingSteps,
  wrapOrgOffboardHandler,
} from '../../src/platform/user-data/offboarding.steps';
import { bindKvoxFactoryResetDeps, runKvoxOrgStorageObjects } from '../../src/kvox-objects/factory-reset-storage.step';

const ORG = '11111111-1111-4111-8111-111111111111';
const JOB = '22222222-2222-4222-8222-222222222222';

/** A transaction that records `<model>.<method>` with its args and answers counts. */
function recordingTx(rows: Record<string, unknown[][]> = {}) {
  const pages: Record<string, unknown[][]> = Object.fromEntries(Object.entries(rows).map(([k, v]) => [k, [...v]]));
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

              if (method === 'findMany') return pages[model]?.shift() ?? [];

              return { count: 1 };
            },
          },
        ),
    },
  );
  const names = () => calls.map((entry) => entry.call);
  const order = (call: string) => names().indexOf(call);

  return { tx, calls, names, order };
}

describe('runKvoxOrgContent', () => {
  const run = () => {
    const recorder = recordingTx({ transcript: [[{ id: 't1' }, { id: 't2' }]] });

    return runKvoxOrgContent(recorder.tx, ORG).then((counts) => ({ ...recorder, counts }));
  };

  it('scopes every statement to the organization, directly, through a relation, or by its transcripts’ ids', async () => {
    const { calls } = await run();
    const direct = ['transcript.findMany', 'transcript.deleteMany'];
    const relation = [
      'kgExport.deleteMany',
      'noteExport.deleteMany',
      'note.updateMany',
      'transcriptNameCheck.deleteMany',
      'transcriptExport.deleteMany',
      'transcriptVersion.deleteMany',
      'transcriptSegment.deleteMany',
      'transcriptSpeaker.deleteMany',
    ];
    const byIds = ['searchChunk.deleteMany', 'searchIndexState.deleteMany', 'grant.deleteMany'];

    // Nothing outside the known list runs, so a new unscoped statement fails this test.
    expect([...new Set(calls.map((c) => c.call))].sort()).toEqual([...direct, ...relation, ...byIds].sort());

    for (const { call, args } of calls) {
      const where = JSON.stringify(args.where);

      if (direct.includes(call)) expect({ call, where: args.where.orgId }).toEqual({ call, where: ORG });
      else if (relation.includes(call)) expect({ call, scoped: where.includes(`"orgId":"${ORG}"`) }).toEqual({ call, scoped: true });
      else {
        // The ids are the ones the org-filtered transcript page returned, and nothing broader.
        expect({ call, ids: args.where.documentId?.in ?? args.where.resourceId?.in }).toEqual({ call, ids: ['t1', 't2'] });
      }
    }

    const noteWhere = calls.find((c) => c.call === 'note.updateMany')?.args;

    expect(noteWhere.where).toEqual({ OR: [{ sourceTranscript: { orgId: ORG } }, { sourceObject: { orgId: ORG } }] });
    expect(noteWhere.data).toEqual({ sourceTranscriptId: null, sourceObjectId: null });
    expect(calls.find((c) => c.call === 'grant.deleteMany')?.args.where.resourceType).toBe('transcript');
    expect(calls.find((c) => c.call === 'searchChunk.deleteMany')?.args.where.documentType).toBe('transcript');
  });

  it('never deletes a note, a graph row, an Ask row or a template: they are user-owned', async () => {
    const { names } = await run();

    expect(names().filter((n) => /^(note|noteTemplate|noteVersion|noteGeneration|kg(Entity|Relation|Item|Evidence)|ask\w*)\./.test(n))).toEqual([
      'note.updateMany',
    ]);
  });

  it('removes the Restrict holders before what they point at, and segments before speakers', async () => {
    const { order } = await run();
    const before = (first: string, second: string) => expect(order(first)).toBeLessThan(order(second));

    before('kgExport.deleteMany', 'transcript.deleteMany');
    before('noteExport.deleteMany', 'transcript.deleteMany');
    before('note.updateMany', 'transcript.deleteMany');
    before('transcriptExport.deleteMany', 'transcript.deleteMany');
    before('transcriptVersion.deleteMany', 'transcript.deleteMany');
    before('transcriptSegment.deleteMany', 'transcriptSpeaker.deleteMany');
    before('transcriptSpeaker.deleteMany', 'transcript.deleteMany');
    before('grant.deleteMany', 'transcript.deleteMany');
  });

  it('pages the transcript ids by cursor until a page is empty', async () => {
    const recorder = recordingTx({ transcript: [[{ id: 'a' }, { id: 'b' }], [{ id: 'c' }]] });

    await runKvoxOrgContent(recorder.tx, ORG);

    const pages = recorder.calls.filter((c) => c.call === 'transcript.findMany').map((c) => c.args.where);

    expect(pages).toEqual([{ orgId: ORG }, { orgId: ORG, id: { gt: 'b' } }, { orgId: ORG, id: { gt: 'c' } }]);
    expect(recorder.calls.filter((c) => c.call === 'searchChunk.deleteMany').map((c) => c.args.where.documentId.in)).toEqual([
      ['a', 'b'],
      ['c'],
    ]);
  });

  it('returns the counts, including zero for an organization with no transcript', async () => {
    const empty = recordingTx();
    const counts = await runKvoxOrgContent(empty.tx, ORG);

    expect(counts).toMatchObject({ transcripts: 1, searchChunks: 0, searchIndexState: 0, transcriptGrants: 0 });
    expect(empty.names()).not.toContain('grant.deleteMany');
    expect(empty.names()).not.toContain('searchChunk.deleteMany');
  });
});

/** An in-memory `storage_objects` honouring `orgId`, the surviving-prefix NOT filter and the id cursor. */
function fakeStorage(rows: Array<{ id: string; orgId: string; storageKey: string }>) {
  const table = [...rows].sort((a, b) => (a.id < b.id ? -1 : 1));
  const wheres: any[] = [];
  const matches = (row: (typeof table)[number], where: any): boolean => {
    if (where.orgId && row.orgId !== where.orgId) return false;
    if (where.id?.gt && !(row.id > where.id.gt)) return false;
    if (where.id?.in && !where.id.in.includes(row.id)) return false;
    if (where.NOT?.OR?.some((c: any) => row.storageKey.startsWith(c.storageKey.startsWith))) return false;

    return true;
  };
  const system = {
    storageObject: {
      findMany: async (args: any) => {
        wheres.push(args.where);

        return table
          .filter((row) => matches(row, args.where))
          .slice(0, args.take ?? table.length)
          .map((row) => ({ ...row, s3UploadId: null }));
      },
      deleteMany: async (args: any) => {
        const ids: string[] = args.where.id.in ?? [args.where.id];
        let count = 0;

        for (const id of ids) {
          const at = table.findIndex((row) => row.id === id);

          if (at >= 0) {
            table.splice(at, 1);
            count += 1;
          }
        }

        return { count };
      },
    },
  };

  return { system, table, wheres };
}

const row = (id: string, orgId: string, storageKey: string) => ({ id, orgId, storageKey });
const OTHER_ORG = '33333333-3333-4333-8333-333333333333';

describe('runKvoxOrgStorageObjects', () => {
  afterEach(() => bindKvoxFactoryResetDeps(undefined));

  function bind(rows: ReturnType<typeof row>[], refuse: string[] = []) {
    const fake = fakeStorage(rows);
    const deleted: string[] = [];

    bindKvoxFactoryResetDeps({
      db: { system: () => fake.system } as never,
      storage: {
        delete: async (key: string) => {
          if (refuse.includes(key)) throw new Error(`refused ${key}`);

          deleted.push(key);
        },
        abortMultipartUpload: async () => undefined,
      },
    });

    return { ...fake, deleted };
  }

  it('deletes the organization’s bytes and rows only, and keeps another organization’s and the backups', async () => {
    const { table, deleted, wheres } = bind([
      row('a', ORG, 'transcripts/a'),
      row('b', ORG, 'notes/b'),
      row('c', OTHER_ORG, 'transcripts/c'),
      row('d', ORG, 'database-backups/d.dump'),
    ]);

    const counts = await runKvoxOrgStorageObjects({ orgId: ORG, jobId: JOB });

    expect(counts).toEqual({ storageObjectsDeleted: 2, storageObjectsFailed: 0 });
    expect(deleted.sort()).toEqual(['notes/b', 'transcripts/a']);
    expect(table.map((r) => r.id).sort()).toEqual(['c', 'd']);
    expect(wheres[0]).toEqual({ orgId: ORG, NOT: { OR: [{ storageKey: { startsWith: 'database-backups/' } }] } });
  });

  it('throws only AFTER the whole sweep, with the failed count, keeping the refused row', async () => {
    const { table, deleted } = bind(
      [row('a', ORG, 'transcripts/a'), row('b', ORG, 'transcripts/b'), row('c', ORG, 'transcripts/c')],
      ['transcripts/a'],
    );

    await expect(runKvoxOrgStorageObjects({ orgId: ORG, jobId: JOB })).rejects.toThrow(/1 storage object\(s\) could not be deleted/);

    // The objects after the refused one were still swept.
    expect(deleted.sort()).toEqual(['transcripts/b', 'transcripts/c']);
    expect(table.map((r) => r.id)).toEqual(['a']);
  });

  it('is a no-op the second time', async () => {
    bind([row('a', ORG, 'transcripts/a')]);
    await runKvoxOrgStorageObjects({ orgId: ORG, jobId: JOB });

    await expect(runKvoxOrgStorageObjects({ orgId: ORG, jobId: JOB })).resolves.toEqual({
      storageObjectsDeleted: 0,
      storageObjectsFailed: 0,
    });
  });
});

describe('runKvoxOrgOffboardingSteps', () => {
  afterEach(() => bindKvoxFactoryResetDeps(undefined));

  /** A db port whose `organization.findUnique` answers `org`, recording the content transaction. */
  function port(org: { id: string; isDefault: boolean } | null, events: string[] = []) {
    const recorder = recordingTx({ transcript: [[{ id: 't1' }]] });
    const system = {
      ...fakeStorage([row('a', ORG, 'transcripts/a')]).system,
      organization: {
        findUnique: async (args: any) => {
          events.push('org.lookup');

          return args.where.id === org?.id ? org : null;
        },
      },
    };
    const db = {
      system: () => system,
      runAsSystem: jest.fn(async (_reason: string, fn: (tx: unknown) => Promise<unknown>) => {
        events.push('content');

        return fn(recorder.tx);
      }),
    };

    return { db: db as never, runAsSystem: db.runAsSystem, system, recorder, events };
  }

  function bindStorage(events: string[], refuse = false) {
    bindKvoxFactoryResetDeps({
      db: { system: () => fakeStorage([row('a', ORG, 'transcripts/a')]).system } as never,
      storage: {
        delete: async () => {
          events.push('bytes');

          if (refuse) throw new Error('refused');
        },
        abortMultipartUpload: async () => undefined,
      },
    });
  }

  it.each([
    ['a malformed payload', { orgId: 'not-a-uuid' }],
    ['a missing payload', undefined],
  ])('returns null and touches nothing for %s', async (_label, payload) => {
    const { db, runAsSystem, system } = port({ id: ORG, isDefault: false });
    const lookup = jest.spyOn(system.organization, 'findUnique');

    await expect(runKvoxOrgOffboardingSteps(db, { id: JOB, payload })).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
    expect(runAsSystem).not.toHaveBeenCalled();
  });

  it('returns null and runs nothing when the organization does not exist', async () => {
    const { db, runAsSystem } = port(null);

    await expect(runKvoxOrgOffboardingSteps(db, { id: JOB, payload: { orgId: ORG } })).resolves.toBeNull();
    expect(runAsSystem).not.toHaveBeenCalled();
  });

  it('returns null and runs nothing for the default organization (the platform refuses it)', async () => {
    const { db, runAsSystem } = port({ id: ORG, isDefault: true });

    await expect(runKvoxOrgOffboardingSteps(db, { id: JOB, payload: { orgId: ORG } })).resolves.toBeNull();
    expect(runAsSystem).not.toHaveBeenCalled();
  });

  it('runs the content transaction (with the timeout) and then the storage sweep, returning the counts', async () => {
    const events: string[] = [];
    const { db, runAsSystem } = port({ id: ORG, isDefault: false }, events);

    bindStorage(events);

    const counts = await runKvoxOrgOffboardingSteps(db, { id: JOB, payload: { orgId: ORG, actorUserId: JOB } }, 1234);

    expect(counts).toMatchObject({ transcripts: 1 });
    expect(runAsSystem).toHaveBeenCalledWith('purge', expect.any(Function), { timeout: 1234 });
    expect(events).toEqual(['org.lookup', 'content', 'bytes']);
  });

  it('throws when a storage object failed, after the content step already ran', async () => {
    const events: string[] = [];
    const { db } = port({ id: ORG, isDefault: false }, events);

    bindStorage(events, true);

    await expect(runKvoxOrgOffboardingSteps(db, { id: JOB, payload: { orgId: ORG } })).rejects.toThrow(/could not be deleted/);
    expect(events).toEqual(['org.lookup', 'content', 'bytes']);
  });
});

describe('wrapOrgOffboardHandler', () => {
  afterEach(() => bindKvoxFactoryResetDeps(undefined));

  function handlerWith(events: string[]) {
    return {
      type: 'org.offboard',
      label: 'Organization offboarding',
      profile: { maxRuntimeMs: 1, maxAttempts: 3 },
      process: jest.fn(async (_job: unknown) => void events.push('platform')),
    };
  }

  const dbFor = (events: string[]) =>
    ({
      system: () => ({ organization: { findUnique: async () => (events.push('steps'), null) } }),
      runAsSystem: async () => ({}),
    }) as never;

  it('runs the KVox steps first, then the original process with the same job', async () => {
    const events: string[] = [];
    const handler = handlerWith(events);
    const original = handler.process;
    const job = { id: JOB, payload: { orgId: ORG } };

    expect(wrapOrgOffboardHandler(handler as never, dbFor(events))).toBe(true);
    expect(handler.process).not.toBe(original);

    await handler.process(job as never);

    expect(events).toEqual(['steps', 'platform']);
    expect(original).toHaveBeenCalledWith(job);
    // The handler keeps its identity members.
    expect(handler.label).toBe('Organization offboarding');
    expect(handler.profile).toEqual({ maxRuntimeMs: 1, maxAttempts: 3 });
  });

  it('wraps once: a second call changes nothing and the steps run once per job', async () => {
    const events: string[] = [];
    const handler = handlerWith(events);

    expect(wrapOrgOffboardHandler(handler as never, dbFor(events))).toBe(true);

    const wrapped = handler.process;

    expect(wrapOrgOffboardHandler(handler as never, dbFor(events))).toBe(false);
    expect(handler.process).toBe(wrapped);

    await handler.process({ id: JOB, payload: { orgId: ORG } } as never);

    expect(events).toEqual(['steps', 'platform']);
  });

  it('does not call the platform process when a step throws', async () => {
    const events: string[] = [];
    const handler = handlerWith(events);
    const failing = {
      system: () => ({ organization: { findUnique: async () => ({ id: ORG, isDefault: false }) } }),
      runAsSystem: async () => {
        throw new Error('content failed');
      },
    } as never;

    wrapOrgOffboardHandler(handler as never, failing);

    await expect(handler.process({ id: JOB, payload: { orgId: ORG } } as never)).rejects.toThrow('content failed');
    expect(events).toEqual([]);
  });
});

describe('KvoxOrgOffboardBinding', () => {
  afterEach(() => jest.restoreAllMocks());

  it('wraps the registered org.offboard handler', () => {
    const handler = { type: 'org.offboard', process: jest.fn() };
    const registry = { get: jest.fn(() => handler) };
    const original = handler.process;

    new KvoxOrgOffboardBinding(registry as never, {} as never).onApplicationBootstrap();

    expect(registry.get).toHaveBeenCalledWith('org.offboard');
    expect(handler.process).not.toBe(original);
  });

  it('warns and skips when no handler is registered', () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const registry = { get: jest.fn(() => undefined) };

    expect(() => new KvoxOrgOffboardBinding(registry as never, {} as never).onApplicationBootstrap()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('org.offboard'));
  });

  it('is idempotent across two bootstraps', () => {
    const handler = { type: 'org.offboard', process: jest.fn() };
    const registry = { get: () => handler };
    const binding = new KvoxOrgOffboardBinding(registry as never, {} as never);

    binding.onApplicationBootstrap();

    const wrapped = handler.process;

    binding.onApplicationBootstrap();

    expect(handler.process).toBe(wrapped);
  });
});
