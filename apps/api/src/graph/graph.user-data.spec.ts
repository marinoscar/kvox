import { userDataScopeReaches } from '../user-data/user-data.registries';
import { KG_PURGE_JOB_TYPE, KG_SUBJECT_USER } from './job-types';
import {
  GRAPH_USER_DATA_CATEGORY,
  GRAPH_USER_DATA_HOOKS,
  userDataGraphSchema,
} from './graph.user-data';
import { GraphUserDataHooks } from './graph.user-data.hooks';

// =============================================================================
// The knowledge graph (#357) — `content`/`everything` hand it to `kg.purge`
// (moved from the purge handler's and the summary service's specs by issue #460)
// =============================================================================

const USER_ID = 'user-1';

function harness() {
  const prisma = {
    kgEntity: { count: jest.fn().mockResolvedValue(0) },
    kgItem: { count: jest.fn().mockResolvedValue(0) },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };
  const jobs = { enqueue: jest.fn().mockResolvedValue({ id: 'kg-job-1', status: 'pending' }) };

  return { hooks: new GraphUserDataHooks(prisma as never, jobs as never), prisma, jobs };
}

describe('GraphUserDataHooks — summary', () => {
  it('reports the knowledge graph as entity and item counts, excluding merge tombstones (#357)', async () => {
    const { hooks, prisma } = harness();
    prisma.kgEntity.count.mockResolvedValue(7);
    prisma.kgItem.count.mockResolvedValue(12);

    const result = await hooks.summarize(USER_ID);

    expect(result).toEqual({ entities: 7, items: 12 });
    expect(prisma.kgEntity.count).toHaveBeenCalledWith({
      where: { ownerId: USER_ID, reviewStatus: { not: 'merged' } },
    });
    expect(prisma.kgItem.count).toHaveBeenCalledWith({ where: { ownerId: USER_ID } });
    expect(userDataGraphSchema.safeParse(result).success).toBe(true);
  });
});

describe('GraphUserDataHooks — purge', () => {
  it('enqueues ONE kg.purge { scope: all } for the user, with ordinary dedup', async () => {
    const { hooks, jobs } = harness();

    await hooks.purge(USER_ID);

    expect(jobs.enqueue).toHaveBeenCalledTimes(1);
    expect(jobs.enqueue).toHaveBeenCalledWith({
      type: KG_PURGE_JOB_TYPE,
      reason: 'rerun',
      subjectType: KG_SUBJECT_USER,
      subjectId: USER_ID,
      payload: { userId: USER_ID, scope: 'all' },
    });
    // Ordinary dedup: a re-run while an earlier graph purge is live gets it back.
    expect(jobs.enqueue.mock.calls[0][0]).not.toHaveProperty('skipDedup');
  });

  it('audits the queued graph purge with its job id', async () => {
    const { hooks, prisma } = harness();

    await hooks.purge(USER_ID);

    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER_ID,
        action: 'user_data:graph_purge_queued',
        targetType: 'user',
        targetId: USER_ID,
        meta: { jobId: 'kg-job-1' },
      },
    });
  });

  it('deletes nothing itself — it only enqueues', async () => {
    const { hooks, prisma } = harness();

    await hooks.purge(USER_ID);

    expect(Object.keys(prisma).sort()).toEqual(['auditEvent', 'kgEntity', 'kgItem']);
    expect(prisma.kgEntity).not.toHaveProperty('deleteMany');
  });
});

describe('the `graph` category declaration', () => {
  it('is reached EXACTLY from `content` and `everything` — never from a narrow scope', () => {
    const reaching = ['transcripts', 'notes', 'files', 'content', 'everything'].filter((scope) =>
      userDataScopeReaches(scope, 'graph'),
    );

    expect(reaching).toEqual(['content', 'everything']);
  });

  it('runs second (purge order 20), so graph rows citing about-to-be-deleted documents go with them', () => {
    expect(GRAPH_USER_DATA_CATEGORY.purge?.order).toBe(20);
    expect(GRAPH_USER_DATA_CATEGORY.summary?.key).toBe('graph');
  });

  it('resolves its hooks through the token GraphModule provides', () => {
    expect(GRAPH_USER_DATA_CATEGORY.summary?.inject).toBe(GRAPH_USER_DATA_HOOKS);
    expect(GRAPH_USER_DATA_CATEGORY.purge?.inject).toBe(GRAPH_USER_DATA_HOOKS);
  });
});
