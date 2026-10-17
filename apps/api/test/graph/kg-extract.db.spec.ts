// =============================================================================
// Real-Postgres test: kg.extract end to end (#363, docs/specs/ontology.md §6, §8)
// =============================================================================
//
// What only a real database can show:
//   - request → handler (with a stub provider returning a fixture answer)
//     writes `kg_proposals` (extracting → draft, prompt recorded, stats),
//     `kg_proposal_items` and `kg_evidence` rows with subject_kind
//     `proposal_item`, every item citing at least one of them;
//   - #351's `kg_proposals_note_extracting_uniq_idx` under two CONCURRENT
//     requests: exactly one 202, the other 409 `extraction_running`;
//   - a newer draft discards the older one (#351's one-draft index), with
//     `stats.discardReason = 'superseded'`, in the same transaction.
// =============================================================================

import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import type { PrismaClient, Job } from '@prisma/client';

import { GraphExtractionService, ProposalStageRegistry, KgExtractHandler } from '@marinoscar/kvox-api/graph-extraction';
import { ExtractionInputLoader, ProposalWriter } from './package-internals';
import { GraphOntologyService, GraphPreferencesService } from '@marinoscar/kvox-api/graph';
import { NoteAccessService, NoteOriginService } from '@marinoscar/kvox-api/notes';
import { createDbClient, resolveDbSuite } from '../jobs/db-test-support';
import { createStorageObject } from '../helpers/storage-object.helper';
import { createTranscript as createTranscriptRow } from '../helpers/transcript.helper';
import { asPrismaService } from '../helpers/db-managed-objects.helper';
import { createPlatformTranscriptSharing } from '../helpers/sharing-kit.helper';
import { createAllowAllIdentity, createDbAudit, createDbJobs, createDbSettings } from '../helpers/graph-ports.helper';

const { describeWithDb, dbReachable } = resolveDbSuite('kg-extract.db.spec');

const EMAIL_PREFIX = 'kg-extract-test';

const ANSWER = {
  meeting: { topics: ['throughput'] },
  entities: [
    { ref: 'e1', type: 'Person', label: 'Sarah Chen', aliases: [], props: {}, evidence: [{ source: 's1', quote: "I'm Sarah Chen" }] },
    { ref: 'e2', type: 'Organization', label: 'Northwind Robotics', aliases: ['NWR'], props: { website: null }, evidence: [{ source: 's1', quote: 'Northwind Robotics' }] },
    { ref: 'e3', type: 'Project', label: 'Invented', aliases: [], props: {}, evidence: [{ source: 's42', quote: 'never handed out' }] },
  ],
  relations: [
    { type: 'WORKS_FOR', from: 'e1', to: 'e2', props: {}, validFrom: null, validTo: null, precision: 'unknown', evidence: [{ source: 's1', quote: 'at Northwind Robotics' }] },
  ],
  items: [
    {
      kind: 'commitment',
      title: 'Send proposal',
      statement: 'Sarah will send the updated proposal by Friday.',
      subject: 'e2',
      owner: 'e1',
      counterparty: null,
      status: 'open',
      occurredAt: null,
      dueAt: '2026-03-06',
      validFrom: null,
      validTo: null,
      precision: 'day',
      sensitivity: null,
      props: {},
      evidence: [{ source: 's2', quote: 'a paraphrase' }, { source: 'N', quote: 'send the updated proposal' }],
    },
  ],
};

describeWithDb('kg.extract (real Postgres)', () => {
  let prisma: PrismaClient;
  let service: GraphExtractionService;
  let handler: KgExtractHandler;
  // A scripted `KVOX_AI.generateStructured`: queued answers first, then the handler (if any).
  const queued: Array<{ value: unknown; usage: { inputTokens: number; outputTokens: number } }> = [];
  let structuredHandler: (() => { value: unknown; usage: { inputTokens: number; outputTokens: number } }) | null = null;
  const ai = {
    queueStructured: (value: unknown, options: { usage: { inputTokens: number; outputTokens: number } }) => void queued.push({ value, usage: options.usage }),
    setStructuredHandler: (handler: () => { value: unknown; usage: { inputTokens: number; outputTokens: number } }) => void (structuredHandler = handler),
    reset: () => {
      queued.length = 0;
      structuredHandler = null;
    },
    port: {
      generateStructured: async () => {
        const next = queued.shift() ?? structuredHandler?.();
        if (!next) throw new Error('kg-extract.db.spec: no scripted structured answer');
        return next;
      },
    },
  };

  beforeAll(async () => {
    if (!dbReachable) return;
    prisma = createDbClient();
    await prisma.$connect();

    const resolution = {
      target: { provider: 'openai', model: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, source: 'requested' },
      providerId: 'openai',
      model: 'gpt-4o',
      reasoningEffort: 'medium',
      countTokens: (t: string) => Math.ceil(t.length / 4),
      modelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
      policy: { maxOutputTokens: 8_000, maxInputTokens: 100_000, reasoningEffort: 'none' },
      source: 'task',
      keyConfigured: true,
    };
    const resolver = { resolve: jest.fn(async () => resolution), graphEnabled: jest.fn(async () => true) };
    const settings = createDbSettings(prisma);
    const preferences = new GraphPreferencesService(settings);
    const ontology = new GraphOntologyService(prisma as never, preferences);
    const loader = new ExtractionInputLoader(prisma as never, new NoteOriginService(asPrismaService(prisma) as never, createPlatformTranscriptSharing(prisma)), ontology);
    const writer = new ProposalWriter(prisma as never);
    const jobs = createDbJobs(prisma);

    service = new GraphExtractionService(
      prisma as never,
      new NoteAccessService(prisma as never),
      resolver as never,
      preferences,
      ontology,
      loader,
      jobs.port,
      createDbAudit(prisma),
      createAllowAllIdentity(),
    );
    handler = new KgExtractHandler(
      jobs.port,
      prisma as never,
      loader,
      resolver as never,
      ai.port as never,
      writer,
      new ProposalStageRegistry(),
      preferences,
    );
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  afterEach(async () => {
    if (!dbReachable) return;
    const owner = { owner: { email: { startsWith: EMAIL_PREFIX } } };
    const notes = await prisma.note.findMany({ where: owner, select: { id: true } });
    await prisma.kgProposal.deleteMany({ where: owner });
    await prisma.job.deleteMany({ where: { subjectType: 'note', subjectId: { in: notes.map((n) => n.id) } } });
    await prisma.kgEvidence.deleteMany({ where: owner });
    await prisma.auditEvent.deleteMany({ where: { actorUser: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.noteVersion.deleteMany({ where: { note: owner } });
    await prisma.note.deleteMany({ where: owner });
    await prisma.transcriptSegment.deleteMany({ where: { transcript: owner } });
    await prisma.transcriptSpeaker.deleteMany({ where: { transcript: owner } });
    await prisma.transcript.deleteMany({ where: owner });
    await prisma.storageObject.deleteMany({ where: { uploadedBy: { email: { startsWith: EMAIL_PREFIX } } } });
    await prisma.user.deleteMany({ where: { email: { startsWith: EMAIL_PREFIX } } });
    ai.reset();
  });

  async function fixture() {
    const user = await prisma.user.create({
      data: { email: `${EMAIL_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.test` },
    });
    const source = await createStorageObject(prisma, {
      data: { name: 'r.m4a', size: BigInt(1), mimeType: 'audio/mp4', storageKey: `${EMAIL_PREFIX}/${randomUUID()}`, managedBy: 'transcripts', uploadedById: user.id },
    });
    const transcript = await createTranscriptRow(prisma, {
      data: { ownerId: user.id, title: 'Kickoff call', sourceObjectId: source.id, provider: 'assemblyai' },
    });
    const speakerA = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'A', displayName: 'Sarah Chen', colorIndex: 0 },
    });
    const speakerB = await prisma.transcriptSpeaker.create({
      data: { transcriptId: transcript.id, label: 'B', displayName: 'Speaker B', colorIndex: 1 },
    });
    const s1 = await prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: speakerA.id, startMs: 0, endMs: 4000, ordinal: 1000, text: "Hi, I'm Sarah Chen, VP of Operations at Northwind Robotics.", words: [] },
    });
    const s2 = await prisma.transcriptSegment.create({
      data: { transcriptId: transcript.id, speakerId: speakerB.id, startMs: 4000, endMs: 8000, ordinal: 2000, text: 'Great. Sarah, can you send the proposal?', words: [] },
    });
    const body = '# Kickoff\n\nSarah will send the updated proposal by Friday.';
    const note = await prisma.note.create({
      data: { ownerId: user.id, title: 'Kickoff', body, status: 'ready', sourceType: 'transcript', sourceTranscriptId: transcript.id, currentVersion: 1 },
    });
    await prisma.noteVersion.create({ data: { noteId: note.id, version: 1, kind: 'ai_generated', body } });
    const caller = { id: user.id, email: user.email, roles: [], permissions: ['graph:write'], isActive: true };
    return { user, caller, transcript, note, s1, s2 };
  }

  async function runJob(jobId: string) {
    const job = (await prisma.job.findUnique({ where: { id: jobId } })) as Job;
    await handler.process(job);
    // What the queue does once `process` returns: settle the job, releasing its dedup key.
    await prisma.job.update({ where: { id: jobId }, data: { status: 'succeeded' } });
  }

  it('request → handler writes the proposal, its items and their evidence', async () => {
    const f = await fixture();
    ai.queueStructured(ANSWER, { usage: { inputTokens: 900, outputTokens: 300 } });

    const out = await service.request(f.caller, f.note.id, {});
    const proposal0 = await prisma.kgProposal.findUniqueOrThrow({ where: { id: out.proposal.id } });
    expect(proposal0).toEqual(expect.objectContaining({ status: 'extracting', kind: 'extraction', noteVersion: 1, model: 'gpt-4o', provider: 'openai' }));
    expect(proposal0.jobId).not.toBeNull();
    const job = await prisma.job.findUniqueOrThrow({ where: { id: proposal0.jobId! } });
    expect(job).toEqual(expect.objectContaining({ type: 'kg.extract', subjectType: 'note', subjectId: f.note.id, priority: -5 }));

    await runJob(job.id);

    const proposal = await prisma.kgProposal.findUniqueOrThrow({ where: { id: out.proposal.id } });
    expect(proposal.status).toBe('draft');
    expect(proposal.systemPrompt).toContain('## Entity types');
    expect(proposal.userContent).toContain("s1 [00:00:00] Sarah Chen: Hi, I'm Sarah Chen");
    expect(proposal.stats).toEqual(
      expect.objectContaining({
        phase: 'ready',
        proposed: { entities: 3, relations: 2, items: 1 },
        dropped: { uncited: 1, invalid: 0, unknownType: 0, dangling: 0 },
        quoteNotLocated: 1,
        usage: { inputTokens: 900, outputTokens: 300 },
      }),
    );

    const items = await prisma.kgProposalItem.findMany({ where: { proposalId: proposal.id }, orderBy: { sortOrder: 'asc' } });
    expect(items.map((i) => `${i.kind}:${(i.payload as { type?: string; kind?: string }).type ?? (i.payload as { kind: string }).kind}`)).toEqual([
      'entity:Meeting',
      'entity:Person',
      'entity:Organization',
      'relation:WORKS_FOR',
      'item:commitment',
      'relation:ATTENDED',
    ]);
    const evidence = await prisma.kgEvidence.findMany({ where: { subjectKind: 'proposal_item', subjectId: { in: items.map((i) => i.id) } } });
    for (const item of items) expect(evidence.filter((e) => e.subjectId === item.id).length).toBeGreaterThan(0);
    expect(evidence.every((e) => e.ownerId === f.user.id)).toBe(true);

    // The invented `s42` cite never reached the database.
    expect(JSON.stringify(items)).not.toContain('Invented');

    // Segment evidence: offsets within the segment text, the rev read.
    const person = items[1];
    const personEvidence = evidence.find((e) => e.subjectId === person.id)!;
    expect(personEvidence).toEqual(expect.objectContaining({ transcriptId: f.transcript.id, segmentId: f.s1.id, segmentRev: 1, startMs: 0, endMs: 4000 }));
    expect(f.s1.text.slice(personEvidence.charStart!, personEvidence.charEnd!)).toBe("I'm Sarah Chen");

    // The commitment: one whole-segment cite (not located) + one note cite.
    const commitment = items[4];
    expect(commitment.flags).toContain('quote_not_located');
    const commitmentEvidence = evidence.filter((e) => e.subjectId === commitment.id);
    expect(commitmentEvidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ segmentId: f.s2.id, charStart: null, charEnd: null }),
        expect.objectContaining({ noteId: f.note.id, noteVersion: 1, quote: 'send the updated proposal' }),
      ]),
    );

    // Pre-check: everything here is new with no candidates and no blocking flag.
    expect(items.every((i) => i.decision === 'accept')).toBe(true);

    const audit = await prisma.auditEvent.findFirst({ where: { actorUserId: f.user.id, action: 'graph.extraction_requested' } });
    expect(audit?.meta).toEqual(expect.objectContaining({ proposalId: proposal.id, reason: 'user_request', guidance: false }));
  });

  it('two concurrent requests: one proposal, the other 409 extraction_running', async () => {
    const f = await fixture();
    const [a, b] = await Promise.allSettled([service.request(f.caller, f.note.id, {}), service.request(f.caller, f.note.id, {})]);
    const fulfilled = [a, b].filter((r) => r.status === 'fulfilled');
    const rejected = [a, b].filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);
    expect((rejected[0].reason as ConflictException).getResponse()).toEqual(
      expect.objectContaining({ details: { reason: 'extraction_running' } }),
    );
    await expect(prisma.kgProposal.count({ where: { noteId: f.note.id, status: 'extracting' } })).resolves.toBe(1);
  });

  it('a newer draft supersedes the older one', async () => {
    const f = await fixture();
    // Two runs, one answer each.
    ai.setStructuredHandler(() => ({ value: ANSWER, usage: { inputTokens: 1, outputTokens: 1 } }));

    const first = await service.request(f.caller, f.note.id, {});
    await runJob((await prisma.kgProposal.findUniqueOrThrow({ where: { id: first.proposal.id } })).jobId!);
    const second = await service.request(f.caller, f.note.id, {});
    await runJob((await prisma.kgProposal.findUniqueOrThrow({ where: { id: second.proposal.id } })).jobId!);

    const older = await prisma.kgProposal.findUniqueOrThrow({ where: { id: first.proposal.id } });
    const newer = await prisma.kgProposal.findUniqueOrThrow({ where: { id: second.proposal.id } });
    expect(older.status).toBe('discarded');
    expect(older.stats).toEqual(expect.objectContaining({ discardReason: 'superseded', phase: 'ready' }));
    expect(newer.status).toBe('draft');
  });

  it('a malformed answer fails the proposal with invalid_output and leaves no items', async () => {
    const f = await fixture();
    ai.queueStructured({ entities: 'nope' }, { usage: { inputTokens: 1, outputTokens: 1 } });
    const out = await service.request(f.caller, f.note.id, {});
    await runJob((await prisma.kgProposal.findUniqueOrThrow({ where: { id: out.proposal.id } })).jobId!);
    const proposal = await prisma.kgProposal.findUniqueOrThrow({ where: { id: out.proposal.id } });
    expect(proposal.status).toBe('failed');
    expect(proposal.stats).toEqual(expect.objectContaining({ failure: expect.objectContaining({ errorClass: 'invalid_output' }) }));
    expect(proposal.systemPrompt).not.toBeNull();
    await expect(prisma.kgProposalItem.count({ where: { proposalId: proposal.id } })).resolves.toBe(0);
  });
});
