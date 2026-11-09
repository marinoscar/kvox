// A note generated from a source document (#789): the context, the chunking helpers, the
// prompt, the output schema and the validator. Every name is invented.

import { chunkContext, chunksFor, shiftToNote } from './chunked-run.js';
import { SOURCE_ALIAS, buildExtractionContext } from './extraction-context.js';
import { mergeChunkResults } from './merge-chunks.js';
import { buildExtractionOutputSchema } from './output-schema.js';
import {
  HEADING_NOTE,
  HEADING_SOURCE,
  NOTE_AS_CONTEXT_FRAMING,
  SOURCE_FRAMING,
  assembleExtractionPrompt,
} from './prompt.js';
import { extractionRowCaps } from './row-caps.js';
import { validateExtraction, type ProposedRow, type ValidationResult } from './validate.js';
import { IDS, makeInput } from '../testing/extraction-fixtures.js';

const OBJECT = '2b000000-0000-4000-8000-000000000001';
const SUMMARY = '# Plan summary\n\nA short summary that names Person K9.';
const SOURCE =
  '## Section 1\n\nPerson K1 leads Project P1 for Org Alpha.\n\nMore words here.\n\n' +
  '## Section 2\n\nPerson K2 leads Project P2 for Org Alpha.\n\nEven more words here.\n';
const count = (t: string) => Math.ceil(t.length / 4);

function documentInput(sourceText: { objectId: string; text: string } | null = { objectId: OBJECT, text: SOURCE }) {
  return makeInput({
    transcript: null,
    segments: [],
    speakers: [],
    sourceType: 'document',
    sourceText,
    note: { id: IDS.note, title: 'Plan', bodyAtVersion: SUMMARY, version: 2, contextText: null, createdAt: new Date('2026-03-04T09:00:00.000Z') },
  });
}

const caps = extractionRowCaps(4000, 'none');
type Ok = Extract<ValidationResult, { ok: true }>;
const ok = (r: ValidationResult): Ok => {
  if (!r.ok) throw new Error(r.message);
  return r;
};

function answerCiting(source: string, quote: string) {
  return {
    meeting: { topics: [] },
    entities: [{ ref: 'e1', type: 'Person', label: 'Person K1', aliases: [], props: {}, evidence: [{ source, quote }] }],
    relations: [],
    items: [],
  };
}

describe('the context (#789)', () => {
  it('carries the source text and its whole length; the note stays the generated summary', () => {
    const ctx = buildExtractionContext(documentInput());
    expect(ctx.source).toEqual({ objectId: OBJECT, text: SOURCE, length: SOURCE.length });
    expect(ctx.note.body).toBe(SUMMARY);
  });

  it('has no source for a blank text or when none was loaded', () => {
    expect(buildExtractionContext(documentInput(null)).source).toBeNull();
    expect(buildExtractionContext(documentInput({ objectId: OBJECT, text: '  \n' })).source).toBeNull();
  });
});

describe('chunking the source (#789)', () => {
  it('chunks the source text and leaves the note whole in every chunk', () => {
    const ctx = buildExtractionContext(documentInput());
    // The default threshold keeps this short text in one chunk; force a split with a tiny budget.
    const chunks = chunksFor(ctx, (t) => t.length * 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.map((c) => c.text).join('')).toBe(SOURCE);
    for (const chunk of chunks) {
      const part = chunkContext(ctx, chunk);
      expect(part.source!.text).toBe(chunk.text);
      expect(part.source!.length).toBe(SOURCE.length);
      expect(part.note.body).toBe(SUMMARY);
    }
  });

  it('a one-chunk source is the context itself', () => {
    const ctx = buildExtractionContext(documentInput());
    const [only] = chunksFor(ctx, count);
    expect(chunkContext(ctx, only)).toBe(ctx);
  });

  it('a note without a source chunks its own body, as before', () => {
    const ctx = buildExtractionContext(documentInput(null));
    expect(chunksFor(ctx, count)[0].text).toBe(SUMMARY);
  });

  it('shifts source-text offsets to absolute and leaves note citations alone in a source run', () => {
    const outcome = (() => {
      const row = (evidence: ProposedRow['evidence']) =>
        ({ kind: 'entity', payload: { ref: 'e1', type: 'Person', label: 'A', aliases: [], props: {} }, resolution: null, flags: [], evidence }) as unknown as ProposedRow;
      return {
        rows: [
          row([
            { source: 'source_text', noteId: IDS.note, noteVersion: 2, sourceObjectId: OBJECT, sourceTextLength: 900, charStart: 5, charEnd: 15, quote: 'q' },
            { source: 'note', noteId: IDS.note, noteVersion: 2, charStart: 3, charEnd: 8, quote: 'n' },
          ]),
        ],
        topics: [],
        stats: { proposed: { entities: 1, relations: 0, items: 0 }, dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 }, quoteNotLocated: 0 },
      };
    })();
    const chunk = { index: 1, count: 2, start: 100, end: 200, text: '', leadIn: null };
    const shifted = shiftToNote(outcome, chunk, true).rows[0].evidence;
    expect(shifted[0]).toMatchObject({ charStart: 105, charEnd: 115 });
    expect(shifted[1]).toMatchObject({ charStart: 3, charEnd: 8 });
    // In a note run the note citation shifts and a source citation (which cannot occur) does not.
    expect(shiftToNote(outcome, chunk, false).rows[0].evidence[1]).toMatchObject({ charStart: 103, charEnd: 108 });
  });

  it('merging chunks unions source-text citations on (text object, offsets)', () => {
    const cite = (start: number) => ({
      source: 'source_text' as const,
      noteId: IDS.note,
      noteVersion: 2,
      sourceObjectId: OBJECT,
      sourceTextLength: 900,
      charStart: start,
      charEnd: start + 10,
      quote: 'q',
    });
    const row = (evidence: ReturnType<typeof cite>[]) =>
      ({ kind: 'entity', payload: { ref: 'e1', type: 'Person', label: 'Person K1', aliases: [], props: {} }, resolution: null, flags: [], evidence }) as unknown as ProposedRow;
    const stats = { proposed: { entities: 1, relations: 0, items: 0 }, dropped: { uncited: 0, invalid: 0, unknownType: 0, dangling: 0 }, quoteNotLocated: 0 };
    const merged = mergeChunkResults([
      { rows: [row([cite(0), cite(40)])], topics: [], stats },
      { rows: [row([cite(40), cite(80)])], topics: [], stats },
    ]);
    const entity = merged.rows.find((r) => r.kind === 'entity')!;
    expect(entity.evidence.map((e) => (e as { charStart: number }).charStart)).toEqual([0, 40, 80]);
  });
});

describe('the prompt and the output schema (#789)', () => {
  const ctx = buildExtractionContext(documentInput());
  const prompt = assembleExtractionPrompt(ctx, caps);

  it('shows the source document first and the generated note whole, as context', () => {
    const user = prompt.userContent;
    expect(user).toContain(`${HEADING_SOURCE}\n${SOURCE_FRAMING}\n${SOURCE}`);
    expect(user).toContain(`${HEADING_NOTE} (version 2)\n${NOTE_AS_CONTEXT_FRAMING}\n${SUMMARY}`);
    expect(user.indexOf(HEADING_SOURCE)).toBeLessThan(user.indexOf(HEADING_NOTE));
  });

  it('tells the model to quote the document, not the summary', () => {
    expect(prompt.systemPrompt).toContain(`\`${SOURCE_ALIAS}\` for the source document`);
    expect(prompt.systemPrompt).toContain('not the note');
    expect(buildExtractionOutputSchema(ctx, caps)).toBeDefined();
    expect(JSON.stringify(buildExtractionOutputSchema(ctx, caps))).toContain('`D` for the source document');
  });

  it('a chunk says which part of the document it is, with a read-only lead-in', () => {
    const [chunk] = chunksFor(ctx, (t) => t.length * 100);
    const part = assembleExtractionPrompt(chunkContext(ctx, chunk), caps, { index: 1, count: 3, leadIn: 'Earlier paragraph.' });
    expect(part.userContent).toContain('Part 2 of 3 of one document; propose only what this part supports.');
    expect(part.userContent).toContain('[context only — do not cite]\nEarlier paragraph.\n[end of context]');
    expect(part.userContent).not.toContain('of one note');
  });

  it('a note with no source prompts exactly as before: no source section, no `D`', () => {
    const plain = assembleExtractionPrompt(buildExtractionContext(documentInput(null)), caps);
    expect(plain.userContent).not.toContain(HEADING_SOURCE);
    expect(plain.systemPrompt).not.toContain('source document');
    expect(plain.userContent).toContain(`${HEADING_NOTE} (version 2)\n${SUMMARY}`);
  });
});

describe('validating a citation of the source (#789)', () => {
  const ctx = buildExtractionContext(documentInput());

  it('anchors a `D` quote to the text object with absolute offsets, the length and the note', () => {
    const quote = 'Person K2 leads Project P2 for Org Alpha.';
    const [row] = ok(validateExtraction(answerCiting('D', quote), ctx)).rows.filter((r) => r.kind === 'entity' && r.payload.ref === 'e1');
    const ev = row.evidence[0];
    expect(ev).toEqual({
      source: 'source_text',
      noteId: IDS.note,
      noteVersion: 2,
      sourceObjectId: OBJECT,
      sourceTextLength: SOURCE.length,
      charStart: SOURCE.indexOf(quote),
      charEnd: SOURCE.indexOf(quote) + quote.length,
      quote,
    });
  });

  it('locates a quote case- and whitespace-insensitively, keeping the source text as the quote', () => {
    const [row] = ok(validateExtraction(answerCiting('D', 'person k1  leads\nproject p1'), ctx)).rows.filter((r) => r.payload.ref === 'e1');
    expect(row.evidence[0]).toMatchObject({ source: 'source_text', quote: 'Person K1 leads Project P1' });
  });

  it('drops a `D` quote the source does not contain, and the row with it', () => {
    const result = ok(validateExtraction(answerCiting('D', 'Person K9 leads nothing'), ctx));
    expect(result.rows.find((r) => r.payload.ref === 'e1')).toBeUndefined();
    expect(result.stats.dropped.uncited).toBe(1);
  });

  it('a quote that is only in the summary is not a `D` citation, but is still an `N` one', () => {
    expect(ok(validateExtraction(answerCiting('D', 'names Person K9'), ctx)).rows.find((r) => r.payload.ref === 'e1')).toBeUndefined();
    const viaNote = ok(validateExtraction(answerCiting('N', 'names Person K9'), ctx)).rows.find((r) => r.payload.ref === 'e1')!;
    expect(viaNote.evidence[0]).toMatchObject({ source: 'note', noteId: IDS.note });
  });

  it('`D` was never offered when the note has no source text', () => {
    const plain = buildExtractionContext(documentInput(null));
    const result = ok(validateExtraction(answerCiting('D', 'Person K1 leads Project P1'), plain));
    expect(result.rows.find((r) => r.payload.ref === 'e1')).toBeUndefined();
  });

  it('a chunk validates against its own part: a quote from another part is dropped', () => {
    const chunks = chunksFor(ctx, (t) => t.length * 100);
    expect(chunks.length).toBeGreaterThan(1);
    const first = chunkContext(ctx, chunks[0]);
    const result = ok(validateExtraction(answerCiting('D', 'Person K2 leads Project P2 for Org Alpha.'), first));
    expect(result.rows.find((r) => r.payload.ref === 'e1')).toBeUndefined();
  });
});
