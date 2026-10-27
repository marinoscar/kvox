// Chunked extraction (#777): a long note is several stub-model calls inside one job.
// Every name below is invented. The stub model is deterministic: it answers from the
// "Person Kn leads Project Pn for Org Alpha." sentences present in the part it was given.

import { GRAPH_PREFERENCE_DEFAULTS } from '../../graph/index.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import { KvoxAiError, KvoxRateLimitError, type KvoxJob } from '../../ports/index.js';
import { ProposalStageRegistry } from '../extraction/proposal-stage.js';
import { buildExtractionContext } from '../extraction/extraction-context.js';
import { chunksFor } from '../extraction/chunked-run.js';
import { planExtraction } from '../extraction/graph-extraction.service.js';
import type { ProposedRow } from '../extraction/validate.js';
import { IDS, makeInput } from '../testing/extraction-fixtures.js';
import { KgExtractHandler } from './kg-extract.handler.js';

const PROPOSAL = '1a000000-0000-4000-8000-000000000001';
const payload = { proposalId: PROPOSAL, noteId: IDS.note, noteVersion: 2, userId: IDS.owner, model: 'gpt-4o', reason: 'user_request' };
const job = () => ({ id: 'job-1', payload }) as unknown as KvoxJob;

const SECTIONS = 8;
const filler = (k: number) =>
  Array.from({ length: 3 }, (_, p) => `Paragraph ${p} of section ${k} ${Array.from({ length: 95 }, (_, w) => `word${(w * 7 + k) % 50}`).join(' ')}.`).join('\n\n');
/** ~6k invented words in 8 sections; the first sentence of each section carries the facts. */
const LONG_BODY = Array.from(
  { length: SECTIONS },
  (_, i) => `## Section ${i + 1}\n\nPerson K${i + 1} leads Project P${i + 1} for Org Alpha.\n\n${filler(i + 1)}\n`,
).join('\n');

const countTokens = (t: string) => Math.ceil(t.length / 4);

function answerFor(user: string) {
  const body = user.slice(user.indexOf('# Note'));
  const part = body.includes('[end of context]') ? body.slice(body.lastIndexOf('[end of context]')) : body;
  const entities: unknown[] = [];
  const relations: unknown[] = [];
  const seen = new Set<string>();
  for (const m of part.matchAll(/Person (K\d+) leads Project (P\d+) for Org Alpha\./g)) {
    const quote = m[0];
    const ev = [{ source: 'N', quote }];
    entities.push(
      { ref: 'e1' + m[1], type: 'Person', label: `Person ${m[1]}`, aliases: [], props: {}, evidence: ev },
      { ref: 'e2' + m[1], type: 'Project', label: `Project ${m[2]}`, aliases: [], props: { status: null, startDate: null, endDate: null }, evidence: ev },
    );
    if (!seen.has('org')) {
      seen.add('org');
      entities.push({ ref: 'eorg', type: 'Organization', label: 'Org Alpha', aliases: [], props: {}, evidence: ev });
    }
    relations.push({ type: 'WORKS_FOR', from: 'e1' + m[1], to: 'eorg', props: {}, validFrom: null, validTo: null, precision: 'unknown', evidence: ev });
  }
  return { meeting: { topics: [] }, entities, relations, items: [] };
}

function harness() {
  const requests: Array<{ system: string; user: string }> = [];
  const queue: unknown[] = [];
  const ai = {
    generateStructured: jest.fn(async (_ctx: unknown, req: { system: string; user: string }) => {
      requests.push({ system: req.system, user: req.user });
      const next = queue.shift();
      if (next !== undefined) throw next;
      return { value: answerFor(req.user), usage: { inputTokens: 100, outputTokens: 10 } };
    }),
  };
  const resolution = {
    target: { provider: 'openai', model: 'gpt-4o', contextWindowTokens: 128_000, maxOutputTokens: 16_000, source: 'requested' },
    providerId: 'openai',
    model: 'gpt-4o',
    reasoningEffort: 'medium',
    countTokens,
    modelLimits: { contextWindowTokens: 128_000, maxOutputTokens: 16_000 },
    policy: { maxOutputTokens: 8_000, maxInputTokens: 100_000, reasoningEffort: 'none' },
    source: 'requested',
    keyConfigured: true,
  };

  let commitLog: unknown = null;
  let written: ProposedRow[] = [];
  const writer = {
    recordPrompt: jest.fn(async () => undefined),
    saveChunkProgress: jest.fn(async (_id: string, _stats: unknown, resume: unknown) => {
      commitLog = JSON.parse(JSON.stringify(resume)); // as the JSON column stores it
    }),
    writeItems: jest.fn(async (_p: string, _o: string, rows: ProposedRow[], _stats?: unknown) => {
      written = rows;
      return rows.map((_, i) => `item-${i}`);
    }),
    finalize: jest.fn(async () => true),
    markFailed: jest.fn(async () => undefined),
  };
  const prisma = {
    kgProposal: {
      findUnique: jest.fn(async (args: { select: Record<string, boolean> }) => {
        if (args.select.userGuidance) return { userGuidance: null };
        if (args.select.commitLog) return { commitLog };
        return { id: PROPOSAL, status: 'extracting', ownerId: IDS.owner };
      }),
    },
    note: { findUnique: jest.fn(async () => ({ id: IDS.note, ownerId: IDS.owner, deletedAt: null, status: 'ready' })) },
    kgProposalItem: { findMany: jest.fn(async () => written.map((r, i) => ({ id: `item-${i}`, kind: r.kind, payload: r.payload, resolution: r.resolution, flags: r.flags, decision: 'pending' }))) },
  };
  const input = makeInput({
    transcript: null,
    segments: [],
    speakers: [],
    note: { id: IDS.note, title: 'Long plan', bodyAtVersion: LONG_BODY, version: 2, contextText: null, createdAt: new Date('2026-03-04T09:00:00.000Z') },
  });
  const handler = new KgExtractHandler(
    jobsMock() as never,
    prisma as never,
    { load: jest.fn(async () => input) } as never,
    { resolve: jest.fn(async () => resolution) } as never,
    ai as never,
    writer as never,
    new ProposalStageRegistry(),
    { get: jest.fn(async () => GRAPH_PREFERENCE_DEFAULTS) } as never,
    { afterDraft: jest.fn(async () => undefined) } as never,
  );
  return { handler, requests, queue, writer, ai, input, resolution, written: () => written };
}

describe('KgExtractHandler chunked extraction (#777)', () => {
  it('the invented note is long enough to chunk', () => {
    const { input } = harness();
    const chunks = chunksFor(buildExtractionContext(input), countTokens);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.length).toBeLessThanOrEqual(12);
  });

  it('one call per chunk, in order, each with a part header and caps; rows from every section', async () => {
    const { handler, requests, written, writer, input } = harness();
    const n = chunksFor(buildExtractionContext(input), countTokens).length;
    await handler.process(job());

    expect(requests).toHaveLength(n);
    requests.forEach((r, i) => {
      expect(r.user).toContain(`Part ${i + 1} of ${n} of one note; propose only what this part supports.`);
      expect(r.system).toMatch(/Propose at most \d+ entities/);
      expect(r.system).toContain('Cover everything the text supports with a citation.');
      expect(r.system).toContain('Never propose a row you cannot cite.');
    });
    expect(requests[0].user).not.toContain('[context only');
    expect(requests[1].user).toContain('[context only — do not cite]');

    const rows = written();
    const labels = rows.filter((r) => r.kind === 'entity').map((r) => (r.payload as { label: string }).label);
    for (let k = 1; k <= SECTIONS; k++) {
      expect(labels).toContain(`Person K${k}`);
      expect(labels).toContain(`Project P${k}`);
    }
    // Org Alpha appears in every section but is ONE merged entity, citing every section.
    const orgs = rows.filter((r) => r.kind === 'entity' && (r.payload as { label: string }).label === 'Org Alpha');
    expect(orgs).toHaveLength(1);
    expect(orgs[0].evidence.length).toBe(n);
    // The deterministic Meeting row is added exactly once.
    expect(rows.filter((r) => r.kind === 'entity' && (r.payload as { type: string }).type === 'Meeting')).toHaveLength(1);
    // Relations re-point to the merged Org Alpha ref.
    const orgRef = (orgs[0].payload as { ref: string }).ref;
    const relations = rows.filter((r) => r.kind === 'relation');
    expect(relations).toHaveLength(SECTIONS);
    for (const r of relations) expect((r.payload as { to: unknown }).to).toEqual({ ref: orgRef });
    // The finished draft clears nothing itself (the writer does) and reports progress.
    const stats = writer.writeItems.mock.calls[0][3] as unknown as { chunks: { total: number; completed: number } };
    expect(stats.chunks).toEqual({ total: n, completed: n });
  });

  it('citations are validated per chunk and carry ABSOLUTE offsets into the note body', async () => {
    const { handler, written } = harness();
    await handler.process(job());
    let checked = 0;
    for (const row of written()) {
      for (const e of row.evidence) {
        if (e.source !== 'note' || e.charStart === null || e.charEnd === null) continue;
        expect(LONG_BODY.slice(e.charStart, e.charEnd)).toBe(e.quote);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(SECTIONS);
  });

  it('a quote that is not in the chunk it was asked about is dropped, even if it is elsewhere in the note', async () => {
    const h = harness();
    const original = h.ai.generateStructured.getMockImplementation()!;
    h.ai.generateStructured.mockImplementation(async (c, r) => {
      const out = (await original(c, r)) as { value: any; usage: unknown };
      // Chunk 1 cites a sentence that only exists in a later section.
      if (r.user.includes('Part 1 of')) {
        out.value.entities.push({ ref: 'ex', type: 'Person', label: 'Person Zed', aliases: [], props: {}, evidence: [{ source: 'N', quote: `Person K${SECTIONS} leads Project P${SECTIONS} for Org Alpha.` }] });
      }
      return out as never;
    });
    await h.handler.process(job());
    const labels = h.written().filter((r) => r.kind === 'entity').map((r) => (r.payload as { label: string }).label);
    expect(labels).not.toContain('Person Zed');
  });

  it('a truncated answer halves the caps for THAT chunk only', async () => {
    const h = harness();
    // The first call truncates; its re-ask and every later chunk are normal.
    h.queue.push(new KvoxAiError('truncated', 'Cut off.'));
    await h.handler.process(job());
    const cap = (s: string) => Number(/Propose at most (\d+) entities/.exec(s)![1]);
    expect(cap(h.requests[1].system)).toBeLessThan(cap(h.requests[0].system));
    expect(cap(h.requests[2].system)).toBe(cap(h.requests[0].system));
    const stats = h.writer.writeItems.mock.calls[0][3] as unknown as { truncationRetry: boolean };
    expect(stats.truncationRetry).toBe(true);
  });

  it('resumes after the last completed chunk when the job runs again', async () => {
    const h = harness();
    const n = chunksFor(buildExtractionContext(h.input), countTokens).length;
    // Chunks 1 and 2 succeed, chunk 3 hits a rate limit: the queue defers the job.
    const impl = h.ai.generateStructured.getMockImplementation()!;
    let call = 0;
    h.ai.generateStructured.mockImplementation(async (c, r) => {
      call += 1;
      if (call === 3) throw new KvoxAiError('rate_limit', 'slow down', 30_000);
      return impl(c, r);
    });
    await expect(h.handler.process(job())).rejects.toBeInstanceOf(KvoxRateLimitError);
    expect(h.writer.saveChunkProgress).toHaveBeenCalledTimes(2);
    expect(h.writer.markFailed).not.toHaveBeenCalled();

    h.requests.length = 0;
    h.ai.generateStructured.mockImplementation(impl);
    await h.handler.process(job());
    // Only the chunks after the two saved ones were asked.
    expect(h.requests).toHaveLength(n - 2);
    expect(h.requests[0].user).toContain(`Part 3 of ${n}`);
    const labels = h.written().filter((r) => r.kind === 'entity').map((r) => (r.payload as { label: string }).label);
    for (let k = 1; k <= SECTIONS; k++) expect(labels).toContain(`Person K${k}`);
    const stats = h.writer.writeItems.mock.calls[0][3] as unknown as { usage: { inputTokens: number } };
    // Usage of the saved chunks is carried over, so the total covers all n calls (100 each).
    expect(stats.usage.inputTokens).toBe(100 * n);
  });

  it('ignores saved progress that belongs to a different split of the note', async () => {
    const h = harness();
    await h.writer.saveChunkProgress(PROPOSAL, {}, { kind: 'extract_resume', v: 1, noteVersion: 2, spans: [[0, 5]], done: [], usage: { inputTokens: 0, outputTokens: 0 }, truncationRetry: false });
    const n = chunksFor(buildExtractionContext(h.input), countTokens).length;
    await h.handler.process(job());
    expect(h.requests).toHaveLength(n);
  });

  it('the estimate arithmetic: each chunk is planned on its own, so none is refused for the note being long', () => {
    const h = harness();
    const ctx = buildExtractionContext(h.input);
    const chunks = chunksFor(ctx, countTokens);
    const whole = planExtraction(h.resolution as never, ctx);
    const parts = chunks.map((c) => planExtraction(h.resolution as never, { ...ctx, note: { ...ctx.note, body: c.text } }, undefined, { index: c.index, count: c.count, leadIn: c.leadIn }));
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.promptTokens).toBeLessThan(whole.promptTokens);
  });
});
