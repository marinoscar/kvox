import { userDataScopeReaches } from '../user-data/user-data.registries';
import { ASK_USER_DATA_CATEGORY, ASK_USER_DATA_HOOKS } from './ask.user-data';
import { AskUserDataHooks } from './ask.user-data.hooks';

// =============================================================================
// #376 — Ask conversations: a `content`/`everything` category, deleted inline
// (moved from the purge handler's spec by issue #460)
// =============================================================================

const USER_ID = 'user-1';

function harness() {
  const prisma = {
    askConversation: {
      count: jest.fn().mockResolvedValue(0),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    auditEvent: { create: jest.fn().mockResolvedValue({}) },
  };

  return { hooks: new AskUserDataHooks(prisma as never), prisma };
}

describe('AskUserDataHooks — summary', () => {
  it("counts the caller's saved Ask conversations (#376)", async () => {
    const { hooks, prisma } = harness();
    prisma.askConversation.count.mockResolvedValue(4);

    await expect(hooks.summarize(USER_ID)).resolves.toEqual({ count: 4 });

    expect(prisma.askConversation.count).toHaveBeenCalledWith({ where: { ownerId: USER_ID } });
  });
});

describe('AskUserDataHooks — purge', () => {
  it("deletes every one of the caller's conversations in one owner-scoped deleteMany", async () => {
    const { hooks, prisma } = harness();
    prisma.askConversation.deleteMany.mockResolvedValue({ count: 3 });

    await hooks.purge(USER_ID);

    expect(prisma.askConversation.deleteMany).toHaveBeenCalledTimes(1);
    expect(prisma.askConversation.deleteMany).toHaveBeenCalledWith({ where: { ownerId: USER_ID } });
    expect(prisma.auditEvent.create).toHaveBeenCalledWith({
      data: {
        actorUserId: USER_ID,
        action: 'user_data:ask_conversations_deleted',
        targetType: 'user',
        targetId: USER_ID,
        meta: { count: 3 },
      },
    });
  });
});

describe('the `ask` category declaration', () => {
  it('is a category, never a requestable scope: content/everything reach it, no narrow scope does', () => {
    for (const scope of ['transcripts', 'notes', 'files']) {
      expect(userDataScopeReaches(scope, 'ask')).toBe(false);
    }
    for (const scope of ['content', 'everything']) {
      expect(userDataScopeReaches(scope, 'ask')).toBe(true);
    }
  });

  it('runs FIRST (purge order 10) and reports as `askConversations` after the graph', () => {
    expect(ASK_USER_DATA_CATEGORY.purge?.order).toBe(10);
    expect(ASK_USER_DATA_CATEGORY.summary?.key).toBe('askConversations');
    expect(ASK_USER_DATA_CATEGORY.content).toBe(true);
  });

  it('resolves its hooks through the token AskModule provides', () => {
    expect(ASK_USER_DATA_CATEGORY.summary?.inject).toBe(ASK_USER_DATA_HOOKS);
    expect(ASK_USER_DATA_CATEGORY.purge?.inject).toBe(ASK_USER_DATA_HOOKS);
  });

  it('delegates each registered hook to the matching method', async () => {
    const instance = {
      summarize: jest.fn().mockResolvedValue({ count: 1 }),
      purge: jest.fn().mockResolvedValue(undefined),
    };

    await ASK_USER_DATA_CATEGORY.summary?.run(instance, USER_ID);
    await ASK_USER_DATA_CATEGORY.purge?.run(instance, USER_ID, { jobId: 'j', scope: 'content' });

    expect(instance.summarize).toHaveBeenCalledWith(USER_ID);
    expect(instance.purge).toHaveBeenCalledWith(USER_ID);
  });
});
