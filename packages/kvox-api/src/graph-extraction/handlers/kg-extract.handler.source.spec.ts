// Extraction of a note generated from a source document (#789, epic #773): the stored
// source text is the input, chunked as in #777, and the generated note is context.
// Every name below is invented. The stub model answers from the "Person Kn leads Project Pn
// for Org Alpha." sentences in the SOURCE part it was given and cites them as `D`.

import { GRAPH_PREFERENCE_DEFAULTS } from '../../graph/index.js';
import { jobsMock } from '../__fixtures__/jobs-mock.js';
import type { KvoxJob } from '../../ports/index.js';
import { ProposalStageRegistry } from '../extraction/proposal-stage.js';
import { buildExtractionContext } from '../extraction/extraction-context.js';
import { chunkContext, chunksFor } from '../extraction/chunked-run.js';
import { planExtraction } from '../extraction/graph-extraction.service.js';
import type { ProposedRow } from '../extraction/validate.js';
import { IDS, makeInput } from '../testing/extraction-fixtures.js';
import { KgExtractHandler } from './kg-extract.handler.js';

const PROPOSAL = '1a000000-0000-4000-8000-000000000001';
const SOURCE_OBJECT = '2b000000-0000-4000-8000-000000000001';
const payload = { proposalId: PROPOSAL, noteId: IDS.note, noteVersion: 2, userId: IDS.owner, model: 'gpt-4o', reason: 'user_request' };
const job = () => ({ id: 'job-1', payload }) as unknown as KvoxJob;

const SECTIONS = 8;
const filler = (k: number) =>
  Array.from({ length: 3 }, (_, p) => `Paragraph ${p} of section ${k} ${Array.from({ length: 95 }, (_, w) => `word${(w * 7 + k) % 50}`).join(' ')}.`).join('\n\n');
/** ~6k invented words in 8 sections; the first sentence of each section carries the facts. */
const SOURCE_TEXT = Array.from(
  { length: SECTIONS },
  (_, i) => `## Section ${i + 1}\n\nPerson K${i + 1} leads Project P${i + 1} for Org Alpha.\n\n${filler(i + 1)}\n`,
).join('\n');
/** The generated note is a short summary: it names none of the facts the stub model looks for. */
const SUMMARY = '# Plan summary\n\nA summary of the long plan.';

const countTokens = (t: string) => Math.ceil(t.length / 4);

/** What the model was shown as the document: between the `# Source document` and `# Note` headings. */
function sourcePart(user: string): string {
  const from = user.indexOf('# Source document');
  if (from === -1) return '';
  const part = user.slice(from, user.indexOf('# Note'));
  return part.includes('[end of context]') ? part.slice(part.lastIndexOf('[end of context]')) : part;
}

function answerFor(user: string) {
  const part = sourcePart(user);
  const entities: unknown[] = [];
  const relations: unknown[] = [];
  const seen = new Set<string>();
  for (const m of part.matchAll(/Person (K\d+) leads Project (P\d+) for Org Alpha\./g)) {
    const ev = [{ source: 'D', quote: m[0] }];
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

function harness(opts: { sourceText?: { objectId: string; text: string } | null } = {}) {
  const requests: Array<{ system: string; user: string }> = [];
  const ai = {
    generateStructured: jest.fn(async (_ctx: unknown, req: { system: string; user: string }) => {
      requests.push({ system: req.system, user: req.user });
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

  let written: ProposedRow[] = [];
  const writer = {
    recordPrompt: jest.fn(async () => undefined),
    saveChunkProgress: jest.fn(async () => undefined),
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
        if (args.select.commitLog) return { commitLog: null };
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
    sourceType: 'document',
    sourceText: opts.sourceText === undefined ? { objectId: SOURCE_OBJECT, text: SOURCE_TEXT } : opts.sourceText,
    note: { id: IDS.note, title: 'Long plan', bodyAtVersion: SUMMARY, version: 2, contextText: null, createdAt: new Date('2026-03-04T09:00:00.000Z') },
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
  return { handler, requests, writer, input, resolution, written: () => written };
}

describe('KgExtractHandler with a source document (#789)', () => {
  it('chunks the SOURCE text, not the short generated note', () => {
    const { input } = harness();
    const chunks = chunksFor(buildExtractionContext(input), countTokens);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    expect(chunks.map((c) => c.text).join('')).toBe(SOURCE_TEXT);
  });

  it('without a source text the short note is one chunk, as before', () => {
    const { input } = harness({ sourceText: null });
    expect(chunksFor(buildExtractionContext(input), countTokens)).toHaveLength(1);
  });

  it('one call per source chunk: part header, the source part, and the whole summary as context', async () => {
    const { handler, requests, input } = harness();
    const n = chunksFor(buildExtractionContext(input), countTokens).length;
    await handler.process(job());

    expect(requests).toHaveLength(n);
    requests.forEach((r, i) => {
      expect(r.user).toContain('# Source document');
      expect(r.user).toContain(`Part ${i + 1} of ${n} of one document; propose only what this part supports.`);
      // The generated note rides along whole, as context, in every call.
      expect(r.user).toContain(SUMMARY);
      expect(r.user).toContain('A summary generated from the source document');
      expect(r.system).toContain('`D` for the source document');
    });
    expect(requests[0].user).not.toContain('[context only');
    expect(requests[1].user).toContain('[context only — do not cite]');
    // A call carries its own part only, never the whole document.
    expect(requests[0].user).not.toContain('Section 8');
  });

  it('cites the source text: absolute offsets into it, the text object and its length, and the note', async () => {
    const { handler, written } = harness();
    await handler.process(job());

    let checked = 0;
    for (const row of written()) {
      for (const e of row.evidence) {
        if (e.source !== 'source_text') continue;
        expect(SOURCE_TEXT.slice(e.charStart, e.charEnd)).toBe(e.quote);
        expect(e.sourceObjectId).toBe(SOURCE_OBJECT);
        expect(e.sourceTextLength).toBe(SOURCE_TEXT.length);
        expect(e.noteId).toBe(IDS.note);
        expect(e.noteVersion).toBe(2);
        checked += 1;
      }
    }
    // Every section contributed citations, from every chunk.
    expect(checked).toBeGreaterThan(SECTIONS);

    const labels = written().filter((r) => r.kind === 'entity').map((r) => (r.payload as { label: string }).label);
    for (let k = 1; k <= SECTIONS; k++) expect(labels).toContain(`Person K${k}`);
    // Org Alpha is merged into ONE entity that cites the source in every chunk.
    const orgs = written().filter((r) => r.kind === 'entity' && (r.payload as { label: string }).label === 'Org Alpha');
    expect(orgs).toHaveLength(1);
    expect(orgs[0].evidence.every((e) => e.source === 'source_text')).toBe(true);
    expect(orgs[0].evidence.length).toBeGreaterThanOrEqual(3);
  });

  it('a `D` citation is not evidence when no source document was offered', async () => {
    const { handler, written } = harness({ sourceText: null });
    await handler.process(job());
    // The summary holds none of the facts, and the stub finds no source part: nothing is cited.
    expect(written().filter((r) => r.evidence.some((e) => e.source === 'source_text'))).toEqual([]);
  });

  it('plans every chunk on its own, so a long document is not refused for its length', () => {
    const h = harness();
    const ctx = buildExtractionContext(h.input);
    const chunks = chunksFor(ctx, countTokens);
    const whole = planExtraction(h.resolution as never, ctx);
    const parts = chunks.map((c) =>
      planExtraction(h.resolution as never, chunkContext(ctx, c), undefined, { index: c.index, count: c.count, leadIn: c.leadIn }),
    );
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.promptTokens).toBeLessThan(whole.promptTokens);
  });
});
