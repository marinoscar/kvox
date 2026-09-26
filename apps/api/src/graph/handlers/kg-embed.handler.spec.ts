import type { Job } from '@prisma/client';

import { profileHash } from '../resolution/profile-text';
import { KG_EMBED_MAX_IDS, KgEmbedHandler, readKgEmbedPayload } from './kg-embed.handler';

const USER = '11111111-1111-4111-8111-111111111111';
const E1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const E2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const I1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

const job = (payload: unknown) => ({ id: 'job-1', payload }) as unknown as Job;

function build(options: { embedderOk?: boolean; entities?: any[]; items?: any[] } = {}) {
  const executed: unknown[] = [];
  const prisma = {
    kgEntity: {
      findMany: jest.fn(async ({ where }: any) =>
        where.reviewStatus ? (options.entities ?? []) : [{ id: 'org', label: 'Northwind' }, { id: E1, label: 'Sarah Chen' }],
      ),
    },
    kgEntityAlias: { findMany: jest.fn(async () => [{ entityId: E1, alias: 'S. Chen' }]) },
    kgRelation: { findMany: jest.fn(async () => [{ fromId: E1, toId: 'org', type: 'HAS_ROLE', props: { title: 'CTO' } }]) },
    kgItem: { findMany: jest.fn(async () => options.items ?? []) },
    $queryRaw: jest.fn(async () => []),
    $executeRaw: jest.fn((...args: unknown[]) => {
      executed.push(args);
      return Promise.resolve(1);
    }),
    $transaction: jest.fn(async (ops: unknown[]) => ops),
  };
  const embed = jest.fn(async (texts: string[]) => texts.map(() => Array(1536).fill(0.01)));
  const embedder = {
    resolve: jest.fn(async () =>
      options.embedderOk === false
        ? { ok: false, reason: 'ai_key_missing' }
        : { ok: true, providerId: 'openai', model: 'text-embedding-3-small', maxBatchSize: 128, embed },
    ),
  };
  const registry = { register: jest.fn() };
  const throttle = { registerProviderKey: jest.fn() };
  const handler = new KgEmbedHandler(registry as never, prisma as never, embedder as never, throttle as never);
  return { handler, prisma, embed, throttle, executed };
}

describe('kg.embed', () => {
  it('declares its profile and registers itself', () => {
    const { handler } = build();
    expect(handler.type).toBe('kg.embed');
    expect(handler.profile).toEqual({ maxRuntimeMs: 5 * 60_000, maxAttempts: 3 });
    // Server-only: no node result members.
    expect((handler as unknown as Record<string, unknown>).nodeResultSchema).toBeUndefined();
    expect((handler as unknown as Record<string, unknown>).persistNodeResult).toBeUndefined();
  });

  it('refuses a payload over the batch ceiling', () => {
    const ids = Array.from({ length: KG_EMBED_MAX_IDS + 1 }, () => E1);
    expect(readKgEmbedPayload({ userId: USER, subjectKind: 'entity', ids })).toBeNull();
    expect(readKgEmbedPayload({ userId: USER, subjectKind: 'entity', ids: ids.slice(1) })).not.toBeNull();
  });

  it('returns normally, embedding nothing, when the owner cannot embed', async () => {
    const t = build({ embedderOk: false, entities: [{ id: E1, type: 'Person', label: 'Sarah Chen', embeddingHash: null }] });
    await expect(t.handler.process(job({ userId: USER, subjectKind: 'entity', ids: [E1] }))).resolves.toBeUndefined();
    expect(t.embed).not.toHaveBeenCalled();
    expect(t.prisma.kgEntity.findMany).not.toHaveBeenCalled();
  });

  it('embeds only rows whose content hash changed, after registering the per-user throttle key', async () => {
    const text = 'Person: Sarah Chen\nAlso known as: S. Chen\nOrganization: Northwind\nRole: CTO';
    const unchanged = profileHash('text-embedding-3-small', text);
    const t = build({
      entities: [
        { id: E1, type: 'Person', label: 'Sarah Chen', embeddingHash: unchanged },
        { id: E2, type: 'Person', label: 'Joe', embeddingHash: 'stale' },
      ],
    });
    await t.handler.process(job({ userId: USER, subjectKind: 'entity', ids: [E1, E2] }));
    expect(t.embed).toHaveBeenCalledTimes(1);
    expect(t.embed.mock.calls[0][0]).toEqual(['Person: Joe']);
    expect(t.throttle.registerProviderKey).toHaveBeenCalledWith('kg.embed', `ai-provider:${USER}`);
    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(t.executed).toHaveLength(1);
  });

  it('is idempotent: a retry after success finds every hash equal and calls nothing', async () => {
    const hash = profileHash('text-embedding-3-small', 'Person: Joe');
    const t = build({ entities: [{ id: E2, type: 'Person', label: 'Joe', embeddingHash: hash }] });
    await t.handler.process(job({ userId: USER, subjectKind: 'entity', ids: [E2] }));
    expect(t.embed).not.toHaveBeenCalled();
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('never embeds a sensitive PersonFact, and clears a stale vector on one', async () => {
    const t = build({
      items: [
        { id: I1, kind: 'person_fact', title: 'x', statement: 'private', sensitivity: 'sensitive', subjectId: null, embeddingHash: 'old' },
      ],
    });
    await t.handler.process(job({ userId: USER, subjectKind: 'item', ids: [I1] }));
    expect(t.embed).not.toHaveBeenCalled();
    expect(t.executed).toHaveLength(1); // the clearing UPDATE
  });
});
