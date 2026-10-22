// =============================================================================
// POST /ask/conversations/:id/messages with a `scope` (GIC-17, #678): a scope that is not the
// asker's is a 404 BEFORE any row is written; a readable one travels in the job payload as ids.
// =============================================================================

import { NotFoundException } from '@nestjs/common';

import { AskMessagesService } from './ask-messages.service.js';
import { ASK_SCOPE_NOT_FOUND } from './ask-scope.js';

const OWNER = '11111111-1111-4111-8111-111111111111';
const CONV = '33333333-3333-4333-8333-333333333333';
const ENTITY = '44444444-4444-4444-8444-444444444444';
const FOREIGN = '55555555-5555-4555-8555-555555555555';

function setup() {
  const created: Array<Record<string, unknown>> = [];
  const enqueued: Array<{ payload: Record<string, unknown> }> = [];
  const row = (extra: Record<string, unknown>) => ({
    id: `msg-${created.length}`,
    conversationId: CONV,
    createdAt: new Date(),
    jobId: null,
    content: '',
    toolCalls: [],
    citations: [],
    model: null,
    provider: null,
    promptTokens: null,
    completionTokens: null,
    errorClass: null,
    finishReason: null,
    ...extra,
  });
  const tx = {
    askMessage: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        const made = row(data);
        created.push(made);
        return made;
      },
      update: async ({ data }: { data: Record<string, unknown> }) => ({ ...created[created.length - 1], ...data }),
    },
    askConversation: { updateMany: async () => ({ count: 1 }) },
  };
  const prisma = {
    kgEntity: {
      findMany: async ({ where }: { where: { id: { in: string[] }; ownerId: string } }) =>
        where.ownerId === OWNER ? where.id.in.filter((id) => id === ENTITY).map((id) => ({ id, label: 'Joe', type: 'Person' })) : [],
    },
    kgEvidence: { findMany: async () => [] },
    kgItem: { findMany: async () => [] },
    kgRelation: { findMany: async () => [] },
    $transaction: async (fn: (t: typeof tx) => unknown) => fn(tx),
  };
  const service = new AskMessagesService(
    prisma as never,
    { requireConversation: async () => ({ id: CONV, title: 'x' }) } as never,
    { resolve: async () => ({ model: 'm', providerId: 'p', reasoningEffort: null, source: 'user' }) } as never,
    {
      enqueueWithin: async (_tx: unknown, input: { payload: Record<string, unknown> }) => {
        enqueued.push(input);
        return { id: 'job-1' };
      },
    } as never,
  );
  return { service, created, enqueued };
}

describe('AskMessagesService.post with a scope (GIC-17)', () => {
  it('answers 404 and writes nothing when a scope id is not readable by the asker', async () => {
    const { service, created, enqueued } = setup();
    const error = await service
      .post(OWNER, CONV, { content: 'How is Joe involved?', scope: { entityIds: [FOREIGN] } })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(ASK_SCOPE_NOT_FOUND);
    expect(created).toHaveLength(0);
    expect(enqueued).toHaveLength(0);
  });

  it('carries a readable scope in the job payload as ids only', async () => {
    const { service, enqueued } = setup();
    await service.post(OWNER, CONV, { content: 'How is Joe involved?', scope: { entityIds: [ENTITY, ENTITY] } });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].payload.scope).toEqual({ entityIds: [ENTITY], evidenceIds: [] });
  });

  it('adds no scope to the payload when none, or an empty one, is sent', async () => {
    const { service, enqueued } = setup();
    await service.post(OWNER, CONV, { content: 'hello' });
    await service.post(OWNER, CONV, { content: 'hello', scope: {} });
    expect(enqueued.map((e) => 'scope' in e.payload)).toEqual([false, false]);
  });
});
