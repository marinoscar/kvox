import { NOTE_IMPORT_BATCH_SETTLED_EVENT } from '@marinoscar/kvox-contract/notes';

import { GRAPH_CHANGED_EVENT, GRAPH_PROPOSAL_DRAFTED_EVENT } from '../../src/graph/index.js';
import { NOOP_KVOX_WEBHOOKS, KvoxPortsModule } from '../../src/core/index.js';
import { KVOX_WEBHOOKS } from '../../src/ports/index.js';
import { createRecordingKvoxWebhooks } from '../../src/testing/index.js';
import { TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT } from '../../src/transcripts/index.js';
import {
  KVOX_WEBHOOK_EMIT_JOB_TYPE,
  KVOX_WEBHOOK_EVENTS,
  KVOX_WEBHOOK_GRAPH_COMMITTED,
  KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
  KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED,
  KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED,
  WebhookEmitHandler,
  WebhookEventsListener,
} from '../../src/webhooks/index.js';

function bus() {
  const handlers = new Map<string, (p: unknown) => Promise<void> | void>();
  return {
    port: {
      emit: jest.fn(),
      subscribe: jest.fn((name: string, h: (p: unknown) => Promise<void> | void) => {
        handlers.set(name, h);
        return () => undefined;
      }),
    },
    fire: async (name: string, payload: unknown) => handlers.get(name)?.(payload),
  };
}

const jobsPort = () => ({ enqueue: jest.fn(async (_input?: unknown) => ({ id: 'j1', deduplicated: false })), registerHandler: jest.fn() });

describe('webhook catalog', () => {
  it('has the four user events with unique keys and valid examples', () => {
    expect(KVOX_WEBHOOK_EVENTS.map((e) => e.key)).toEqual([
      'kvox.graph.proposal_drafted',
      'kvox.graph.committed',
      'kvox.notes.import_batch_settled',
      'kvox.transcripts.speakers_identified',
    ]);
    for (const def of KVOX_WEBHOOK_EVENTS) {
      expect(def.audience).toBe('user');
      expect(def.payloadSchema.safeParse(def.example).success).toBe(true);
    }
  });

  it('rejects any content-bearing or unknown field (strict)', () => {
    for (const def of KVOX_WEBHOOK_EVENTS) {
      for (const extra of ['content', 'title', 'name', 'quote', 'statement', 'text']) {
        const withExtra = { ...(def.example as object), [extra]: 'Person A said something' };
        expect(def.payloadSchema.safeParse(withExtra).success).toBe(false);
      }
    }
    const batch = KVOX_WEBHOOK_EVENTS.find((e) => e.key === KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED)!;
    const example = batch.example as { counts: object };
    expect(batch.payloadSchema.safeParse({ ...example, counts: { ...example.counts, filename: 'x' } }).success).toBe(false);
  });
});

describe('WebhookEventsListener', () => {
  function setup() {
    const events = bus();
    const jobs = jobsPort();
    new WebhookEventsListener(events.port as never, jobs as never).onModuleInit();
    return { events, jobs };
  }
  const payloadOf = (jobs: ReturnType<typeof jobsPort>) => (jobs.enqueue.mock.calls[0] as unknown[])[0] as Record<string, any>;

  it('enqueues a proposal draft with ids only', async () => {
    const { events, jobs } = setup();
    await events.fire(GRAPH_PROPOSAL_DRAFTED_EVENT, { proposalId: 'p', ownerId: 'u', noteId: 'n', noteVersion: 2, kind: 'extraction' });
    expect(payloadOf(jobs)).toMatchObject({
      type: KVOX_WEBHOOK_EMIT_JOB_TYPE,
      skipDedup: true,
      payload: { eventKey: KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED, userId: 'u', refs: { proposalId: 'p', noteId: 'n', noteVersion: 2 } },
    });
  });

  it('enqueues graph.changed only for a proposal commit', async () => {
    const { events, jobs } = setup();
    for (const reason of ['revert', 'merge', 'manual_edit', 'purge', 'import']) {
      await events.fire(GRAPH_CHANGED_EVENT, { ownerId: 'u', reason });
    }
    await events.fire(GRAPH_CHANGED_EVENT, { ownerId: 'u', reason: 'commit' }); // no proposal detail
    expect(jobs.enqueue).not.toHaveBeenCalled();
    await events.fire(GRAPH_CHANGED_EVENT, {
      ownerId: 'u',
      reason: 'commit',
      proposalId: 'p',
      counts: { entitiesCreated: 1, relationsCreated: 2, entitiesLinked: 3 },
    });
    expect(payloadOf(jobs).payload).toEqual({
      eventKey: KVOX_WEBHOOK_GRAPH_COMMITTED,
      userId: 'u',
      refs: { proposalId: 'p', entitiesCreated: 1, relationsCreated: 2, entitiesLinked: 3 },
    });
  });

  it('enqueues a settled batch and speaker identification (count only), swallowing an enqueue failure', async () => {
    const { events, jobs } = setup();
    await events.fire(NOTE_IMPORT_BATCH_SETTLED_EVENT, { batchId: 'b', ownerId: 'u', libraryId: null });
    await events.fire(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, { transcriptId: 't', actorUserId: 'u', speakerIds: ['s1', 's2'] });
    expect(jobs.enqueue.mock.calls.map((c) => (c[0] as any).payload)).toEqual([
      { eventKey: KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED, userId: 'u', refs: { batchId: 'b', libraryId: null } },
      { eventKey: KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED, userId: 'u', refs: { transcriptId: 't', speakerCount: 2 } },
    ]);
    jobs.enqueue.mockRejectedValueOnce(new Error('queue down'));
    await expect(events.fire(TRANSCRIPT_SPEAKERS_IDENTIFIED_EVENT, { transcriptId: 't', actorUserId: 'u', speakerIds: [] })).resolves.toBeUndefined();
  });
});

describe('WebhookEmitHandler', () => {
  const job = (payload: unknown) => ({ id: 'j', type: KVOX_WEBHOOK_EMIT_JOB_TYPE, subjectType: 'user', subjectId: 'u', payload, attempts: 1, orgId: 'org-1' });
  const db = {
    kgProposalItem: { count: jest.fn(async () => 7) },
    noteImportBatchItem: {
      groupBy: jest.fn(async () => [
        { status: 'imported', _count: { _all: 5 } },
        { status: 'failed', _count: { _all: 1 } },
        { status: 'queued', _count: { _all: 2 } },
      ]),
    },
  };

  it('registers server-only and publishes the proposal draft with its item count', async () => {
    const jobs = jobsPort();
    const port = createRecordingKvoxWebhooks();
    const handler = new WebhookEmitHandler(jobs as never, db as never, port);
    handler.onModuleInit();
    expect(jobs.registerHandler).toHaveBeenCalledWith(handler);
    expect(handler.type).toBe('kvox.webhook_emit');
    expect((handler as any).nodeResultSchema).toBeUndefined();
    expect((handler as any).persistNodeResult).toBeUndefined();
    expect(Object.keys(handler.profile).sort()).toEqual(['maxAttempts', 'maxRuntimeMs']);

    await handler.process(
      job({ eventKey: KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED, userId: 'u', refs: { proposalId: 'p', noteId: 'n', noteVersion: 2 } }),
    );
    expect(port.emitted).toEqual([
      {
        eventKey: KVOX_WEBHOOK_GRAPH_PROPOSAL_DRAFTED,
        data: { proposalId: 'p', noteId: 'n', noteVersion: 2, itemCount: 7 },
        ctx: { orgId: 'org-1', userId: 'u' },
      },
    ]);
  });

  it('publishes batch outcome counts and passes complete events through', async () => {
    const port = createRecordingKvoxWebhooks();
    const handler = new WebhookEmitHandler(jobsPort() as never, db as never, port);
    await handler.process(job({ eventKey: KVOX_WEBHOOK_NOTES_IMPORT_BATCH_SETTLED, userId: 'u', refs: { batchId: 'b', libraryId: 'l' } }));
    await handler.process(job({ eventKey: KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED, userId: 'u', refs: { transcriptId: 't', speakerCount: 2 } }));
    expect(port.emitted[0]!.data).toEqual({
      batchId: 'b',
      libraryId: 'l',
      counts: { imported: 5, failed: 1, missing: 0, skipped: 0, other: 2 },
    });
    expect(port.emitted[1]!.data).toEqual({ transcriptId: 't', speakerCount: 2 });
  });

  it('refuses content-bearing refs, ignores unreadable payloads and unknown events, and is a no-op unbound', async () => {
    const port = createRecordingKvoxWebhooks();
    const handler = new WebhookEmitHandler(jobsPort() as never, db as never, port);
    await expect(
      handler.process(job({ eventKey: KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED, userId: 'u', refs: { transcriptId: 't', speakerCount: 1, name: 'Person A' } })),
    ).rejects.toThrow();
    await handler.process(job({ nope: true }));
    await handler.process(job({ eventKey: 'kvox.unknown', userId: 'u', refs: {} }));
    expect(port.emitted).toEqual([]);

    const unbound = new WebhookEmitHandler(jobsPort() as never, db as never, undefined);
    await expect(
      unbound.process(job({ eventKey: KVOX_WEBHOOK_TRANSCRIPTS_SPEAKERS_IDENTIFIED, userId: 'u', refs: { transcriptId: 't', speakerCount: 1 } })),
    ).resolves.toBeUndefined();
  });
});

describe('KVOX_WEBHOOKS default', () => {
  it('is a no-op that resolves', async () => {
    await expect(NOOP_KVOX_WEBHOOKS.emit('kvox.graph.committed', {}, { orgId: null })).resolves.toBeUndefined();
  });

  it('is provided by KvoxPortsModule.forRoot when the host binds none, and the host binding wins when it does', () => {
    const stub = { useValue: {} };
    const ports = { ai: stub, objectStore: stub, jobs: stub, identity: stub, notify: stub, prisma: stub, settings: stub, secrets: stub } as never;
    const find = (mod: ReturnType<typeof KvoxPortsModule.forRoot>) =>
      (mod.providers as Array<{ provide: symbol; useValue?: unknown }>).find((p) => p.provide === KVOX_WEBHOOKS);
    expect(find(KvoxPortsModule.forRoot({ ports }))?.useValue).toBe(NOOP_KVOX_WEBHOOKS);
    const bound = { emit: jest.fn() };
    expect(find(KvoxPortsModule.forRoot({ ports: { ...(ports as object), webhooks: { useValue: bound } } as never }))?.useValue).toBe(bound);
  });
});
