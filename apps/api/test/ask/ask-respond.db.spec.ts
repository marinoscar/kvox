// =============================================================================
// Real-Postgres test: posting a question and answering it (issue #378)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db`. The real
// `AskMessagesService` (transaction, `enqueueWithin`, the partial unique index)
// and the real `AskRespondHandler` over the REAL toolset against real rows —
// only the platform's `stream()` is a scripted fake (`FakeAskStream`); the port's
// `chat()` mapping above it is production code (#476).
//
//   - a full turn: two tool steps, `tool_calls`, validated `citations`
//     (an `itm` resolved to its evidence with `via`, an `ent`, an invented
//     marker `valid: false`), tokens, model/provider, `finish_reason`, the
//     conversation's derived title;
//   - a `sensitive` PersonFact never appears in any request sent to the provider;
//   - two concurrent POSTs → exactly one 202 and one 409 `ask_turn_running`,
//     decided by `ask_messages_one_running_turn_uniq_idx`;
//   - a conversation deleted before the job runs → the job returns, no rows;
//   - the caps end `step_cap` / `token_cap`; text before a tool call never reaches
//     `content`; a 429 before text resets the row to `pending` and rethrows, after
//     flushed text it fails `rate_limit`; every call is made for the `graph_agent`
//     feature under the job (the platform records the usage row from that scope).
// =============================================================================

import { ConflictException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import { AskAccessService } from '../../src/ask/ask-access.service';
import { AskMessagesService } from '../../src/ask/ask-messages.service';
import { AskRespondHandler } from '../../src/ask/handlers/ask-respond.handler';
import { AskToolset } from '../../src/ask/tools/ask-toolset';
import { EntityBriefTool } from '../../src/ask/tools/entity-brief.tool';
import { EvidenceTool } from '../../src/ask/tools/evidence.tool';
import { GetEntityTool } from '../../src/ask/tools/get-entity.tool';
import { ListCommitmentsTool } from '../../src/ask/tools/list-commitments.tool';
import { NeighborsTool } from '../../src/ask/tools/neighbors.tool';
import { SearchTool } from '../../src/ask/tools/search.tool';
import { TimelineTool } from '../../src/ask/tools/timeline.tool';
import { GraphAccessService } from '../../src/graph/access/graph-access.service';
import { EntityBriefService } from '../../src/graph/brief/entity-brief.service';
import { EntityViewService } from '../../src/graph/brief/entity-view.service';
import { GraphOntologyService } from '../../src/graph/ontology/graph-ontology.service';
import { GraphPreferencesService } from '../../src/graph/preferences/graph-preferences.service';
import { GraphEvidenceService } from '../../src/graph/read/graph-evidence.service';
import { GraphNeighborhoodService } from '../../src/graph/read/graph-neighborhood.service';
import { GraphReadService } from '../../src/graph/read/graph-read.service';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';
import { JobsService, RateLimitError } from '@marinoscar/platform-api/jobs';
import { createDbManagedObjects, UNUSED_STORAGE } from '../helpers/db-managed-objects.helper';
import { createFakeAskPort, done, failure, FakeAskStream, text, toolCall } from '../../scripts/ask-eval/fake-provider';
import { ASK_MAX_TOOL_STEPS } from '../../src/ask/ask-limits';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-respond.db.spec');

const EMAIL_PREFIX = 'ask-respond-test';
const ROLE_NAME = `${EMAIL_PREFIX}-role-${Date.now()}`;

describeWithDb('ask.respond (real Postgres)', () => {
  let prisma: PrismaClient;
  let toolset: AskToolset;
  let roleId: string;

  const stream = new FakeAskStream();

  let service: AskMessagesService;
  let handler: AskRespondHandler;

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    const p = prisma as unknown as PrismaService;
    const access = new GraphAccessService(p);
    const transcriptAccess = new TranscriptAccessService(p);
    const preferences = new GraphPreferencesService(p);
    const ontology = new GraphOntologyService(p, preferences);
    const reads = new GraphReadService(p, access, ontology, transcriptAccess);
    const neighborhood = new GraphNeighborhoodService(p, access, ontology);
    const evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p), createDbManagedObjects(prisma, UNUSED_STORAGE));
    const search = { search: async () => ({ results: [], nextCursor: null }) };
    const brief = new EntityBriefService(
      p,
      access,
      ontology,
      new EntityViewService(p),
      search as never,
      { resolve: async () => { throw new Error('never'); } } as never,
      { enqueue: async () => { throw new Error('never'); } } as never,
    );
    toolset = new AskToolset(
      new SearchTool(reads, search as never, p),
      new GetEntityTool(reads, ontology, p),
      new NeighborsTool(neighborhood, p),
      new TimelineTool(reads, p),
      new EvidenceTool(evidence, p),
      new EntityBriefTool(brief, p),
      new ListCommitmentsTool(p),
      preferences,
    );
    const jobs = new JobsService(p);
    // Readiness is scripted; `chat()` and everything under it is production code over the fake stream.
    const port = createFakeAskPort(stream, { model: 'gpt-test' });
    service = new AskMessagesService(p, new AskAccessService(p), port.ai, jobs);
    handler = new AskRespondHandler(
      { register: () => undefined } as never,
      p,
      port.ai,
      port.settings as never,
      { registerProviderKey: () => undefined } as never,
      toolset,
    );

    const permission = await prisma.permission.upsert({
      where: { name: 'graph:read' },
      update: {},
      create: { name: 'graph:read' },
    });
    const role = await prisma.role.create({ data: { name: ROLE_NAME } });
    roleId = role.id;
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
  });

  afterAll(async () => {
    if (dbReachable && roleId) await prisma.role.delete({ where: { id: roleId } }).catch(() => undefined);
    await prisma?.$disconnect();
  });

  beforeEach(() => {
    stream.reset();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    // `jobs` has no FK to the user; remove this spec's own `ask.respond` rows.
    const users = await prisma.user.findMany({ where: { email: { startsWith: EMAIL_PREFIX } }, select: { id: true } });
    for (const u of users) {
      await prisma.job.deleteMany({ where: { type: 'ask.respond', payload: { path: ['userId'], equals: u.id } } });
    }
    await cleanupGraphFixtures(prisma, EMAIL_PREFIX);
  }, 60_000);

  async function owner(suffix: string) {
    const user = await createUser(prisma, EMAIL_PREFIX, suffix);
    await prisma.userRole.create({ data: { userId: user.id, roleId } });
    return { user, g: new GraphFixture(prisma, user.id) };
  }

  async function conversation(ownerId: string) {
    return prisma.askConversation.create({ data: { ownerId } });
  }

  async function jobFor(messageId: string): Promise<Job> {
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: messageId } });
    return prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
  }

  it('answers a full turn: tool steps, validated citations, tokens, and the title', async () => {
    const { user, g } = await owner('turn');
    const sarah = await g.entity('Person', 'Sarah Chen');
    await g.item('decision', { subjectId: sarah, statement: 'Hire Sarah as design lead', occurredAt: new Date('2026-09-01T00:00:00Z') });
    await g.item('person_fact', { subjectId: sarah, statement: 'Health detail nobody may see', sensitivity: 'sensitive' });
    const conv = await conversation(user.id);

    const posted = await service.post(user.id, conv.id, { content: 'What   did we decide about Sarah Chen?' });
    expect(posted.userMessage).toMatchObject({ role: 'user', status: 'complete' });
    expect(posted.assistantMessage).toMatchObject({ role: 'assistant', status: 'pending', model: 'gpt-test', provider: 'openai' });
    const job = await jobFor(posted.assistantMessage.id);
    expect(job).toMatchObject({ type: 'ask.respond', priority: -10, subjectType: 'ask_message', subjectId: posted.assistantMessage.id });

    stream.enqueue([
      text('Searching.'),
      toolCall('c1', 'search', '{"query":"Sarah Chen","scope":"entities","limit":null}'),
      done('tool_calls', 100, 10),
    ]);
    stream.enqueue([
      toolCall('c2', 'timeline', '{"entity":"ent1","asOf":null,"kinds":null,"limit":null}'),
      done('tool_calls', 200, 10),
    ]);
    stream.enqueue([
      text('You decided to hire Sarah Chen as design lead.[^itm1] She is in your graph.[^ent1] '),
      text('Nothing else.[^ev99]'),
      done('stop', 300, 30),
    ]);
    await handler.process(job);

    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    expect(row).toMatchObject({
      status: 'complete',
      finishReason: 'stop',
      promptTokens: 600,
      completionTokens: 50,
      model: 'gpt-test',
      provider: 'openai',
      errorClass: null,
    });
    expect(row.content).not.toContain('Searching.');
    expect((row.toolCalls as Array<{ name: string; error: string | null }>).map((t) => [t.name, t.error])).toEqual([
      ['search', null],
      ['timeline', null],
    ]);
    const citations = row.citations as Array<Record<string, unknown>>;
    expect(citations).toEqual([
      expect.objectContaining({ marker: 'itm1', kind: 'evidence', valid: true, via: { kind: 'item', id: expect.any(String) } }),
      expect.objectContaining({ marker: 'ent1', kind: 'entity', valid: true, id: sarah, label: 'Sarah Chen' }),
      expect.objectContaining({ marker: 'ev99', valid: false, id: null }),
    ]);
    const itemEvidence = await prisma.kgEvidence.findFirstOrThrow({
      where: { subjectKind: 'item', subjectId: (citations[0].via as { id: string }).id },
    });
    expect(citations[0].id).toBe(itemEvidence.id);

    // §15: a sensitive PersonFact never left the deployment.
    expect(stream.requests).toHaveLength(3);
    expect(JSON.stringify(stream.requests)).not.toContain('Health detail');
    expect(JSON.stringify(stream.requests)).not.toMatch(new RegExp(sarah));

    // One platform call per model round trip, each for the graph agent under THIS job
    // (the platform records one usage row per call from that scope).
    expect(stream.scopes).toHaveLength(3);
    for (const scope of stream.scopes) {
      expect(scope).toMatchObject({ userId: user.id, feature: 'graph_agent', jobId: job.id });
    }
    // The tool round trip: the second call replays the first call and its result.
    const second = JSON.stringify(stream.requests[1].input);
    expect(second).toContain('"type":"function_call"');
    expect(second).toContain('"type":"function_call_output"');
    expect(stream.requests.every((r) => r.tools.length === 7)).toBe(true);

    const conv2 = await prisma.askConversation.findUniqueOrThrow({ where: { id: conv.id } });
    expect(conv2.title).toBe('What did we decide about Sarah Chen?');
  });

  it('lets exactly one of two concurrent questions through (409 ask_turn_running, index-enforced)', async () => {
    const { user } = await owner('race');
    const conv = await conversation(user.id);
    const results = await Promise.allSettled([
      service.post(user.id, conv.id, { content: 'First?' }),
      service.post(user.id, conv.id, { content: 'Second?' }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect(JSON.stringify((rejected[0].reason as ConflictException).getResponse())).toContain('ask_turn_running');
    // The loser's transaction rolled back whole: one question, one answer, one job.
    expect(await prisma.askMessage.count({ where: { conversationId: conv.id } })).toBe(2);

    // Once the turn settles, the next question is accepted.
    await prisma.askMessage.updateMany({ where: { conversationId: conv.id, role: 'assistant' }, data: { status: 'complete' } });
    await expect(service.post(user.id, conv.id, { content: 'Third?' })).resolves.toBeDefined();
  });

  it('returns normally, writing nothing, when the conversation was deleted before the job ran', async () => {
    const { user } = await owner('gone');
    const conv = await conversation(user.id);
    const posted = await service.post(user.id, conv.id, { content: 'Anyone there?' });
    const job = await jobFor(posted.assistantMessage.id);
    await prisma.askConversation.delete({ where: { id: conv.id } });

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(stream.requests).toHaveLength(0);
    expect(await prisma.askMessage.count({ where: { id: posted.assistantMessage.id } })).toBe(0);
  });

  /** Posts a question for a fresh owner and returns what a cap/limit scenario needs. */
  async function post(suffix: string, content = 'What is going on?') {
    const { user } = await owner(suffix);
    const conv = await conversation(user.id);
    const posted = await service.post(user.id, conv.id, { content });
    return { user, id: posted.assistantMessage.id, job: await jobFor(posted.assistantMessage.id) };
  }

  const ANSWER = 'Nothing is recorded about that yet, so there is nothing to report on this question.';

  it('keeps text emitted before a tool call out of content (the hold)', async () => {
    const { id, job } = await post('hold');
    stream.enqueue([text('Let me look that up for you'), text(' right away…'), toolCall('c1', 'search', '{"query":"x","scope":"all","limit":null}'), done('tool_calls')]);
    stream.enqueue([text(ANSWER), done('stop')]);
    await handler.process(job);

    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'complete', finishReason: 'stop', content: ANSWER });
    expect(row.content).not.toContain('Let me look');
  });

  it(`ends step_cap after ${ASK_MAX_TOOL_STEPS} tool steps: the next call is forced with toolChoice none`, async () => {
    const { id, job } = await post('stepcap');
    for (let i = 0; i < ASK_MAX_TOOL_STEPS; i += 1) {
      stream.enqueue([toolCall(`c${i}`, 'search', '{"query":"x","scope":"all","limit":null}'), done('tool_calls')]);
    }
    stream.enqueue([text(ANSWER), done('stop')]);
    await handler.process(job);

    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id } });
    expect(row).toMatchObject({ status: 'complete', finishReason: 'step_cap', content: ANSWER });
    expect(stream.requests).toHaveLength(ASK_MAX_TOOL_STEPS + 1);
    expect(stream.requests[ASK_MAX_TOOL_STEPS].toolChoice).toBe('none');
    expect(stream.requests[0].toolChoice).toBe('auto');
  });

  it('ends token_cap when the answer stops on length', async () => {
    const { id, job } = await post('tokencap');
    stream.enqueue([text(ANSWER), done('length')]);
    await handler.process(job);

    expect(await prisma.askMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'complete',
      finishReason: 'token_cap',
      content: ANSWER,
    });
  });

  it('a 429 before any text resets the row to pending and rethrows (no attempt charged)', async () => {
    const { id, job } = await post('defer');
    stream.enqueue([failure('AI_RATE_LIMITED', 'slow down')]);

    await expect(handler.process(job)).rejects.toBeInstanceOf(RateLimitError);
    expect(await prisma.askMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'pending',
      content: '',
      toolCalls: [],
    });
  });

  it('a 429 after flushed text fails the turn rate_limit and keeps the text', async () => {
    const { id, job } = await post('afterText');
    const long = 'Part of an answer. '.repeat(30);
    stream.enqueue([text(long), toolCall('c1', 'search', '{"query":"x","scope":"all","limit":null}'), done('tool_calls')]);
    stream.enqueue([failure('AI_RATE_LIMITED', 'slow down')]);

    await expect(handler.process(job)).resolves.toBeUndefined();
    expect(await prisma.askMessage.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'failed',
      errorClass: 'rate_limit',
      content: long,
    });
  });
});
