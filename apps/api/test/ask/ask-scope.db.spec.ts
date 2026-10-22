// =============================================================================
// Real-Postgres test: the `scope` of an Ask question (GIC-17, #678)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db`. The real `AskMessagesService` and
// `AskRespondHandler` over real rows, with only the model scripted:
//
//   - a scope of the asker's own entities and relation evidence travels in the job payload as ids
//     and reaches the agent as starting handles in the system prompt (never a uuid, never a quote);
//   - another owner's entity or evidence, a merged entity, an unknown id and the evidence of a
//     `sensitive` PersonFact each answer the SAME 404 for the whole request, with nothing written;
//   - a sensitive PersonFact's statement never appears in any request sent to the provider;
//   - an entity that vanishes between the POST and the job is dropped, and the turn still answers.
// =============================================================================

import { NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@prisma/client';

import { ASK_SCOPE_NOT_FOUND } from '@marinoscar/kvox-api/ask';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';
import { done, FakeAskStream, text } from '../../scripts/ask-eval/fake-provider';
import { createAskTurn, toKvoxJob } from '../helpers/ask-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-scope.db.spec');

const EMAIL_PREFIX = 'ask-scope-test';
const SECRET = 'Recovering from knee surgery, tell nobody';

describeWithDb('Ask turn scope (real Postgres)', () => {
  let prisma: PrismaClient;
  const stream = new FakeAskStream();
  let service: ReturnType<typeof createAskTurn>['service'];
  let handler: ReturnType<typeof createAskTurn>['handler'];

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    ({ service, handler } = createAskTurn(prisma, stream, { model: 'gpt-test' }));
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    stream.reset();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    for (const u of users) {
      await prisma.job.deleteMany({ where: { type: 'ask.respond', payload: { path: ['userId'], equals: u.id } } });
    }
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function world() {
    const user = await createUser(prisma, EMAIL_PREFIX, 'a');
    const stranger = await createUser(prisma, EMAIL_PREFIX, 'b');
    const mine = new GraphFixture(prisma, user.id);
    const theirs = new GraphFixture(prisma, stranger.id);
    const joe = await mine.entity('Person', 'Joe Rivera');
    const copilot = await mine.entity('Project', 'Copilot rollout');
    const involved = await mine.relation('INVOLVED_IN', joe, copilot);
    const fact = await mine.item('person_fact', { subjectId: joe, statement: SECRET, sensitivity: 'sensitive' });
    const merged = await mine.entity('Person', 'Joe (duplicate)', { reviewStatus: 'merged', mergedIntoId: joe });
    const foreign = await theirs.entity('Person', 'Not yours');
    const foreignRelation = await theirs.relation('INVOLVED_IN', foreign, await theirs.entity('Project', 'Theirs'));
    const evidenceOf = async (kind: 'relation' | 'item' | 'entity', id: string, owner = user.id) =>
      (await prisma.kgEvidence.findFirstOrThrow({ where: { ownerId: owner, subjectKind: kind, subjectId: id } })).id;
    const conversation = await prisma.askConversation.create({ data: { ownerId: user.id } });
    return {
      user,
      joe,
      copilot,
      merged,
      foreign,
      conversation,
      relationEvidence: await evidenceOf('relation', involved),
      factEvidence: await evidenceOf('item', fact),
      foreignEvidence: await evidenceOf('relation', foreignRelation, stranger.id),
    };
  }

  const messageCount = (conversationId: string) => prisma.askMessage.count({ where: { conversationId } });

  it('carries the asker’s own scope in the job payload and names it to the agent as starting handles', async () => {
    const w = await world();
    const posted = await service.post(w.user.id, w.conversation.id, {
      content: 'How is Joe involved in the rollout?',
      scope: { entityIds: [w.joe, w.copilot], evidenceIds: [w.relationEvidence] },
    });
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
    expect((job.payload as { scope: unknown }).scope).toEqual({
      entityIds: [w.joe, w.copilot],
      evidenceIds: [w.relationEvidence],
    });

    stream.enqueue([text('Joe sponsors the rollout, per the notes you reviewed.[^ent1]'), done('stop', 100, 20)]);
    await handler.process(toKvoxJob(job));

    const system = stream.requests[0].instructions ?? '';
    expect(system).toContain('The user selected these on the graph before asking:');
    expect(system).toContain('ent1 (Joe Rivera, Person)');
    expect(system).toContain('ent2 (Copilot rollout, Project)');
    expect(system).toContain('rel1 (INVOLVED_IN, INVOLVED_IN)');
    expect(system).toContain('starting points only, not evidence');
    // Ids and the evidence's quote never reach the model through the prompt.
    for (const id of [w.joe, w.copilot, w.relationEvidence]) expect(JSON.stringify(stream.requests)).not.toContain(id);
    const answered = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    expect(answered.status).toBe('complete');
    expect(answered.citations).toEqual([expect.objectContaining({ marker: 'ent1', valid: true, id: w.joe })]);
  });

  it.each([
    ['another owner’s entity', (w: Awaited<ReturnType<typeof world>>) => ({ entityIds: [w.foreign] })],
    ['another owner’s evidence', (w: Awaited<ReturnType<typeof world>>) => ({ evidenceIds: [w.foreignEvidence] })],
    ['a merged entity', (w: Awaited<ReturnType<typeof world>>) => ({ entityIds: [w.merged] })],
    ['an unknown id', () => ({ entityIds: ['00000000-0000-4000-8000-00000000dead'] })],
    ['the evidence of a sensitive PersonFact', (w: Awaited<ReturnType<typeof world>>) => ({ evidenceIds: [w.factEvidence] })],
    ['one readable and one unreadable id', (w: Awaited<ReturnType<typeof world>>) => ({ entityIds: [w.joe, w.foreign] })],
  ])('answers one 404 and writes nothing for %s', async (_name, scopeOf) => {
    const w = await world();
    const error = await service
      .post(w.user.id, w.conversation.id, { content: 'Tell me.', scope: scopeOf(w) })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as NotFoundException).message).toBe(ASK_SCOPE_NOT_FOUND);
    expect(await messageCount(w.conversation.id)).toBe(0);
    expect(await prisma.job.count({ where: { type: 'ask.respond', payload: { path: ['userId'], equals: w.user.id } } })).toBe(0);
  });

  it('never puts a sensitive PersonFact in a request, scope or not', async () => {
    const w = await world();
    const posted = await service.post(w.user.id, w.conversation.id, { content: 'What about Joe?', scope: { entityIds: [w.joe] } });
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
    stream.enqueue([text('Joe is in your graph.[^ent1]'), done('stop', 100, 20)]);
    await handler.process(toKvoxJob(job));
    expect(JSON.stringify(stream.requests)).not.toContain('knee surgery');
  });

  it('drops an entity that vanished since the question was asked, and still answers', async () => {
    const w = await world();
    const posted = await service.post(w.user.id, w.conversation.id, {
      content: 'How is Joe involved?',
      scope: { entityIds: [w.joe, w.copilot] },
    });
    // Merged away between the POST and the job.
    await prisma.kgEntity.update({ where: { id: w.copilot }, data: { mergedIntoId: w.joe, reviewStatus: 'merged' } });
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
    stream.enqueue([text('Joe is in your graph.[^ent1]'), done('stop', 100, 20)]);
    await handler.process(toKvoxJob(job));

    const system = stream.requests[0].instructions ?? '';
    expect(system).toContain('ent1 (Joe Rivera, Person)');
    expect(system).not.toContain('Copilot rollout');
    expect((await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } })).status).toBe('complete');
  });

  it('adds nothing to the prompt or the payload without a scope', async () => {
    const w = await world();
    const posted = await service.post(w.user.id, w.conversation.id, { content: 'Hello?' });
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
    expect(job.payload as Record<string, unknown>).not.toHaveProperty('scope');
    stream.enqueue([text('Hi.'), done('stop', 10, 2)]);
    await handler.process(toKvoxJob(job));
    expect(stream.requests[0].instructions ?? '').not.toContain('selected these on the graph');
  });
});
