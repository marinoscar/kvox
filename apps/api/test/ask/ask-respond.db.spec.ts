// =============================================================================
// Real-Postgres test: posting a question and answering it (issue #378)
// =============================================================================
//
// Excluded from `npm test`; run by `npm run test:db`. The real
// `AskMessagesService` (transaction, `enqueueWithin`, the partial unique index)
// and the real `AskRespondHandler` over the REAL toolset against real rows —
// only the AI provider is a scripted fake and the resolver a stub around it.
//
//   - a full turn: two tool steps, `tool_calls`, validated `citations`
//     (an `itm` resolved to its evidence with `via`, an `ent`, an invented
//     marker `valid: false`), tokens, model/provider, `finish_reason`, the
//     conversation's derived title;
//   - a `sensitive` PersonFact never appears in any request sent to the provider;
//   - two concurrent POSTs → exactly one 202 and one 409 `ask_turn_running`,
//     decided by `ask_messages_one_running_turn_uniq_idx`;
//   - a conversation deleted before the job runs → the job returns, no rows.
// =============================================================================

import { ConflictException } from '@nestjs/common';
import type { Job, PrismaClient } from '@prisma/client';

import type { AiChatEvent, AiChatRequest } from '../../src/ai/providers/ai-provider.interface';
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
import { JobsService } from '../../src/jobs/jobs.service';
import { NoteAccessService } from '../../src/notes/access/note-access.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TranscriptAccessService } from '../../src/transcripts/transcript-access.service';
import { GraphFixture, cleanupGraphFixtures, connectTestPrisma, createUser } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-respond.db.spec');

const EMAIL_PREFIX = 'ask-respond-test';
const ROLE_NAME = `${EMAIL_PREFIX}-role-${Date.now()}`;

describeWithDb('ask.respond (real Postgres)', () => {
  let prisma: PrismaClient;
  let toolset: AskToolset;
  let roleId: string;

  const requests: AiChatRequest[] = [];
  let scripts: AiChatEvent[][] = [];
  const provider = {
    id: 'openai',
    label: 'OpenAI',
    settingsSchema: { safeParse: () => ({ success: true, data: {} }) },
    chat: (_ctx: unknown, request: AiChatRequest) => {
      requests.push(JSON.parse(JSON.stringify(request)) as AiChatRequest);
      const events = scripts.shift() ?? [];
      return (async function* () {
        for (const e of events) yield e;
      })();
    },
  };
  const resolver = {
    resolve: async () => ({
      providerId: 'openai',
      provider,
      model: 'gpt-test',
      reasoningEffort: 'low',
      countTokens: (t: string) => Math.ceil(t.length / 4),
      descriptor: { id: 'gpt-test', contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
      policy: { providers: {}, maxInputTokens: 100_000, maxOutputTokens: 16_000, requestTimeoutMs: 120_000 },
      source: 'task',
      keyConfigured: true,
    }),
  };

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
    const evidence = new GraphEvidenceService(p, access, transcriptAccess, new NoteAccessService(p));
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
    service = new AskMessagesService(p, new AskAccessService(p), resolver as never, jobs);
    handler = new AskRespondHandler(
      { register: () => undefined } as never,
      p,
      resolver as never,
      { getSecret: async () => 'sk-test' } as never,
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
    requests.length = 0;
    scripts = [];
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

    scripts = [
      [
        { kind: 'delta', text: 'Searching.' },
        { kind: 'tool_call', id: 'c1', name: 'search', argumentsJson: '{"query":"Sarah Chen","scope":"entities","limit":null}' },
        { kind: 'done', finishReason: 'tool_calls', usage: { promptTokens: 100, completionTokens: 10 } },
      ],
      [
        { kind: 'tool_call', id: 'c2', name: 'timeline', argumentsJson: '{"entity":"ent1","asOf":null,"kinds":null,"limit":null}' },
        { kind: 'done', finishReason: 'tool_calls', usage: { promptTokens: 200, completionTokens: 10 } },
      ],
      [
        { kind: 'delta', text: 'You decided to hire Sarah Chen as design lead.[^itm1] She is in your graph.[^ent1] ' },
        { kind: 'delta', text: 'Nothing else.[^ev99]' },
        { kind: 'done', finishReason: 'stop', usage: { promptTokens: 300, completionTokens: 30 } },
      ],
    ];
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
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests)).not.toContain('Health detail');
    expect(JSON.stringify(requests)).not.toMatch(new RegExp(sarah));

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
    expect(requests).toHaveLength(0);
    expect(await prisma.askMessage.count({ where: { id: posted.assistantMessage.id } })).toBe(0);
  });
});
