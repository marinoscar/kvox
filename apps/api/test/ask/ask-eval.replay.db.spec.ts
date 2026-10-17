// =============================================================================
// Real-Postgres replay test: the Ask evaluation harness, no model needed (#382)
// =============================================================================
//
// Seeds #362's ENTIRE gold graph (every fixture, exactly as the real
// `ask:eval` runner would) under one throwaway user, then drives the REAL
// `AskRespondHandler` — real toolset, real Prisma, real `HandleRegistry` and
// citation mapper — through 6 representative questions with a SCRIPTED fake
// platform stream (`fake-provider.ts`, `FakeAskStream`): a fixed sequence of
// tool calls per question, using handles the real tools actually returned, then a
// canned answer that cites them — plus one answer that cites an unissued `[^ev99]`.
// The fake sits UNDER the real `KVOX_AI` binding (`createKvoxAi` over `PlatformAiRuntime`, #579), so the
// event mapping runs too (#476).
//
// This is the harness's own self-test, the same role `kg:eval --predictions
// gold` plays for extraction (#362): it proves the seeder, the tools, the
// handler and the scorer agree end to end WITHOUT a real model or a paid key,
// so it runs in CI's `smoke` job (`npm run test:db`) on every push.
//
// What it asserts, per the issue: citation validity detected as < 1 for the
// deliberately-invalid answer and 1.0 for the rest, and the leak check finds
// nothing anywhere it looked (the graph's `sensitive` PersonFacts are real —
// Marcus Webb's shellfish allergy — and are never returned by any tool).
// =============================================================================

import type { PrismaClient } from '@prisma/client';

import { internals } from '@marinoscar/kvox-api/ask/testing';
import { connectTestPrisma } from '../graph/graph-read.fixtures';
import { resolveDbSuite } from '../jobs/db-test-support';
import { loadGoldenSet } from '../../scripts/kg-eval/load';
import { done, FakeAskStream, text, toolCall } from '../../scripts/ask-eval/fake-provider';
import { scoreCitationValidity, scoreSensitiveLeak } from '../../scripts/ask-eval/scorer';
import { seedGraph, teardownSeededGraph, type SeededGraph } from '../../scripts/ask-eval/seed-graph';
import { createAskTurn, toKvoxJob } from '../helpers/ask-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('ask-eval.replay.db.spec');

/** Marcus Webb's `sensitive` PersonFact (m13) — must never appear in a tool result or an answer. */
const SENSITIVE_TEXT = 'shellfish allergy';

describeWithDb('ask:eval replay (real Postgres, scripted platform stream, no model)', () => {
  let prisma: PrismaClient;
  let seeded: SeededGraph;
  let handler: ReturnType<typeof createAskTurn>['handler'];
  let service: ReturnType<typeof createAskTurn>['service'];
  let provider: FakeAskStream;
  let roleId: string;
  /** Every `messages` array sent to the provider, across EVERY question this suite asks — for the leak gate. */
  const allCapturedPrompts: string[] = [];

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = connectTestPrisma();
    await prisma.$connect();
    seeded = await seedGraph(prisma, loadGoldenSet());

    const permission = await prisma.permission.upsert({
      where: { name: 'graph:read' },
      update: {},
      create: { name: 'graph:read' },
    });
    const role = await prisma.role.create({ data: { name: `ask-eval-replay-role-${Date.now()}` } });
    roleId = role.id;
    await prisma.rolePermission.create({ data: { roleId, permissionId: permission.id } });
    await prisma.userRole.create({ data: { userId: seeded.userId, roleId } });

    provider = new FakeAskStream();
    // Readiness is scripted; `chat()`, the AI port's adapter and everything under them are production
    // code over the fake platform stream.
    ({ service, handler } = createAskTurn(prisma, provider));
  }, 120_000);

  afterAll(async () => {
    if (!dbReachable) return;
    if (seeded) await teardownSeededGraph(prisma, seeded.userId).catch(() => undefined);
    if (roleId) await prisma.role.delete({ where: { id: roleId } }).catch(() => undefined);
    await prisma?.$disconnect();
  }, 120_000);

  /** Posts one question, runs the scripted script, and returns the finished message + this turn's captured requests. */
  async function ask(question: string, script: () => void) {
    const conv = await prisma.askConversation.create({ data: { ownerId: seeded.userId } });
    const posted = await service.post(seeded.userId, conv.id, { content: question });
    provider.resetRequests();
    script();
    const row = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const job = await prisma.job.findUniqueOrThrow({ where: { id: row.jobId! } });
    await handler.process(toKvoxJob(job));
    const finished = await prisma.askMessage.findUniqueOrThrow({ where: { id: posted.assistantMessage.id } });
    const capturedPrompts = provider.requests.map((r) => JSON.stringify(r));
    allCapturedPrompts.push(...capturedPrompts);
    return { message: internals.toAskMessage(finished), capturedPrompts };
  }

  it('search → get_entity → cites [^ent1]: valid, citation validity 1.0', async () => {
    const { message } = await ask('Who does Sarah Chen work for?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'Sarah Chen', scope: 'entities', limit: null })), done('tool_calls')]);
      provider.enqueue([toolCall('c2', 'get_entity', JSON.stringify({ entity: 'ent1' })), done('tool_calls')]);
      provider.enqueue([text('Sarah Chen works for Northwind Robotics.[^ent1]'), done('stop')]);
    });
    expect(message.status).toBe('complete');
    expect(scoreCitationValidity(message.citations)).toBe(1);
    expect(message.citations.every((c) => c.valid)).toBe(true);
  });

  it('search → evidence(ent1) → cites [^ev1]: valid, citation validity 1.0', async () => {
    const { message } = await ask('Where is the pick-path pilot?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'pick-path pilot', scope: 'entities', limit: null })), done('tool_calls')]);
      provider.enqueue([toolCall('c2', 'evidence', JSON.stringify({ subject: 'ent1', limit: 5 })), done('tool_calls')]);
      provider.enqueue([text('Here is what was said about it.[^ev1]'), done('stop')]);
    });
    expect(message.status).toBe('complete');
    expect(scoreCitationValidity(message.citations)).toBe(1);
    expect(message.citations).toHaveLength(1);
    expect(message.citations[0]).toMatchObject({ marker: 'ev1', kind: 'evidence', valid: true });
  });

  it('search → get_entity → timeline → evidence(itm1) → cites [^ev1]: valid, citation validity 1.0', async () => {
    const { message } = await ask('What has happened with Halden Freight?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'Halden Freight', scope: 'entities', limit: null })), done('tool_calls')]);
      provider.enqueue([toolCall('c2', 'timeline', JSON.stringify({ entity: 'ent1', asOf: null, kinds: null, limit: 5 })), done('tool_calls')]);
      provider.enqueue([toolCall('c3', 'evidence', JSON.stringify({ subject: 'itm1', limit: 3 })), done('tool_calls')]);
      provider.enqueue([text('Several things happened.[^ev1]'), done('stop')]);
    });
    expect(message.status).toBe('complete');
    expect(scoreCitationValidity(message.citations)).toBe(1);
  });

  it('a not-found question: search returns nothing, the answer cites nothing (citation validity vacuously 1.0)', async () => {
    const { message } = await ask('What did Jamie Fontaine decide about the Meridian project?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'Jamie Fontaine', scope: 'all', limit: null })), done('tool_calls')]);
      provider.enqueue([text("I couldn't find Jamie Fontaine or a Meridian project in your graph."), done('stop')]);
    });
    expect(message.status).toBe('complete');
    expect(message.citations).toHaveLength(0);
    expect(scoreCitationValidity(message.citations)).toBe(1);
  });

  it('cites entity + evidence together, all valid: citation validity 1.0', async () => {
    const { message } = await ask('Who runs the northern depots cutover, and what is the evidence?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'Marcus Webb', scope: 'entities', limit: null })), done('tool_calls')]);
      provider.enqueue([toolCall('c2', 'get_entity', JSON.stringify({ entity: 'ent1' })), done('tool_calls')]);
      provider.enqueue([toolCall('c3', 'evidence', JSON.stringify({ subject: 'ent1', limit: 3 })), done('tool_calls')]);
      provider.enqueue([text('Marcus Webb is involved.[^ent1] See here.[^ev1]'), done('stop')]);
    });
    expect(message.status).toBe('complete');
    expect(scoreCitationValidity(message.citations)).toBe(1);
    expect(message.citations.every((c) => c.valid)).toBe(true);
  });

  it('THE PLANTED BAD ANSWER: cites an unissued [^ev99] alongside a real one — citation validity < 1', async () => {
    const { message } = await ask('What is going on with the Corvid Health project?', () => {
      provider.enqueue([toolCall('c1', 'search', JSON.stringify({ query: 'Corvid Health', scope: 'entities', limit: null })), done('tool_calls')]);
      provider.enqueue([toolCall('c2', 'get_entity', JSON.stringify({ entity: 'ent1' })), done('tool_calls')]);
      provider.enqueue([text('Corvid Health is a client.[^ent1] Also this, which nobody ever returned.[^ev99]'), done('stop')]);
    });
    expect(message.status).toBe('complete');
    const validity = scoreCitationValidity(message.citations);
    expect(validity).toBeLessThan(1);
    expect(message.citations.find((c) => c.marker === 'ev99')).toMatchObject({ valid: false, id: null });
  });

  it('the leak gate: a sensitive PersonFact never reaches a tool result or an answer, across every question above', async () => {
    // Marcus Webb's shellfish allergy is `sensitive` and must never leave the
    // deployment — not in what the provider was shown, and not in what it said.
    for (const prompt of allCapturedPrompts) {
      expect(prompt.toLowerCase()).not.toContain(SENSITIVE_TEXT);
    }
    const finalMessages = await prisma.askMessage.findMany({
      where: { conversation: { ownerId: seeded.userId }, role: 'assistant' },
      select: { content: true },
    });
    for (const m of finalMessages) {
      expect(scoreSensitiveLeak([SENSITIVE_TEXT], m.content, [])).toBe(false);
    }
  });
});
