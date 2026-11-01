import { leadInOf, planChunks, MAX_CHUNKS } from './chunker.js';

const count = (t: string) => Math.ceil(t.length / 4);
const words = (n: number, w = 'lorem') => Array.from({ length: n }, () => w).join(' ');
/** ~`tokens` tokens of plain text. */
const para = (tokens: number, tag = 'word') => `${tag} ${words(Math.floor((tokens * 4) / 6), 'alpha')}.`;

const opts = { threshold: 300, target: 200 };

function assertContiguous(body: string, chunks: ReturnType<typeof planChunks>) {
  expect(chunks[0].start).toBe(0);
  expect(chunks[chunks.length - 1].end).toBe(body.length);
  chunks.forEach((c, i) => {
    expect(body.slice(c.start, c.end)).toBe(c.text);
    expect(c.index).toBe(i);
    expect(c.count).toBe(chunks.length);
    if (i > 0) expect(c.start).toBe(chunks[i - 1].end);
  });
}

describe('planChunks (#777)', () => {
  it('keeps a short body as one chunk with no lead-in', () => {
    const body = '# Title\n\nShort note.';
    const chunks = planChunks(body, count);
    expect(chunks).toEqual([{ index: 0, count: 1, start: 0, end: body.length, text: body, leadIn: null }]);
  });

  it('does not split when splitting is disallowed (a transcript-origin note)', () => {
    const body = Array.from({ length: 6 }, (_, i) => `# S${i}\n\n${para(100)}`).join('\n\n');
    expect(planChunks(body, count, { ...opts, allowSplit: false })).toHaveLength(1);
  });

  it('splits on heading boundaries first and covers the body exactly once', () => {
    const body = Array.from({ length: 6 }, (_, i) => `## Section ${i}\n\n${para(120)}\n`).join('\n');
    const chunks = planChunks(body, count, opts);
    expect(chunks.length).toBeGreaterThan(2);
    assertContiguous(body, chunks);
    // Every chunk after the first starts at a heading line.
    for (const c of chunks.slice(1)) expect(c.text.startsWith('## Section')).toBe(true);
  });

  it('falls back to paragraph boundaries inside one oversize section', () => {
    const body = `# One section\n\n${Array.from({ length: 8 }, (_, i) => para(90, `p${i}`)).join('\n\n')}\n`;
    const chunks = planChunks(body, count, opts);
    expect(chunks.length).toBeGreaterThan(2);
    assertContiguous(body, chunks);
    for (const c of chunks.slice(1)) expect(/^p\d/.test(c.text)).toBe(true);
  });

  it('never splits a table row or a list item mid-line', () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| row ${i} | ${words(8, 'cell')} |`).join('\n');
    const items = Array.from({ length: 60 }, (_, i) => `- item ${i} ${words(8, 'text')}\n  continued ${i}`).join('\n');
    const body = `# Data\n\n| a | b |\n|---|---|\n${rows}\n\n# List\n\n${items}\n`;
    const chunks = planChunks(body, count, opts);
    expect(chunks.length).toBeGreaterThan(3);
    assertContiguous(body, chunks);
    for (const c of chunks) {
      for (const line of c.text.split('\n')) {
        if (line.startsWith('|')) expect(line.endsWith('|')).toBe(true);
        if (line.startsWith('  continued')) expect(line).toMatch(/continued \d+$/);
      }
      // A chunk never starts on a list continuation line.
      expect(c.text.startsWith('  continued')).toBe(false);
    }
  });

  it('does not split inside a fenced code block at a heading-looking line', () => {
    const code = '```\n# not a heading\n\nstill code\n```';
    const body = `# A\n\n${para(150)}\n\n${code}\n\n# B\n\n${para(150)}\n`;
    const chunks = planChunks(body, count, opts);
    assertContiguous(body, chunks);
    const withCode = chunks.filter((c) => c.text.includes('# not a heading'));
    expect(withCode).toHaveLength(1);
    expect(withCode[0].text).toContain('still code');
  });

  it('splits a single huge paragraph on sentence boundaries', () => {
    const body = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} says ${words(10)}.`).join(' ');
    const chunks = planChunks(body, count, opts);
    expect(chunks.length).toBeGreaterThan(2);
    assertContiguous(body, chunks);
    for (const c of chunks.slice(0, -1)) expect(c.text.trimEnd().endsWith('.')).toBe(true);
  });

  it('gives each later chunk the previous chunk last paragraph as read-only lead-in', () => {
    const body = Array.from({ length: 5 }, (_, i) => `## S${i}\n\n${para(100, `first${i}`)}\n\n${para(60, `last${i}`)}\n`).join('\n');
    const chunks = planChunks(body, count, opts);
    expect(chunks[0].leadIn).toBeNull();
    chunks.slice(1).forEach((c, i) => {
      const prev = chunks[i];
      expect(prev.text).toContain(c.leadIn as string);
      expect(c.text).not.toBe(c.leadIn);
    });
  });

  it('caps the lead-in length', () => {
    const lead = leadInOf(`first\n\n${words(500)}`);
    expect((lead as string).length).toBeLessThanOrEqual(800);
    expect(leadInOf('   \n\n  ')).toBeNull();
  });

  it('bounds the chunk count: a longer body gets larger chunks, not more calls', () => {
    const body = Array.from({ length: 400 }, (_, i) => `## S${i}\n\n${para(100)}\n`).join('\n');
    const chunks = planChunks(body, count, opts);
    expect(chunks.length).toBeLessThanOrEqual(MAX_CHUNKS);
    expect(chunks.length).toBeGreaterThan(1);
    assertContiguous(body, chunks);
  });

  it('is deterministic', () => {
    const body = Array.from({ length: 9 }, (_, i) => `## S${i}\n\n${para(120)}\n`).join('\n');
    expect(planChunks(body, count, opts)).toEqual(planChunks(body, count, opts));
  });
});
