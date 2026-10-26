import { EXCERPT_CHARS } from '../../src/notes/dto/note.dto.js';

import { noteExcerpt } from '../../src/notes/note-excerpt.js';

// =============================================================================
// noteExcerpt: the plain-text Notes list excerpt (issue #751)
// =============================================================================

describe('noteExcerpt', () => {
  it('starts a real meeting note at the summary prose, with no markdown syntax', () => {
    const body =
      '# EY Internal — Confidential\n\n## 0. Header\n\n| Field | Details |\n|---|---|\n| Meeting name | Dell-2 |\n\n## 1. Summary\n\nThe team agreed to ship the pilot in March.';
    const excerpt = noteExcerpt(body);

    expect(excerpt.startsWith('The team agreed to')).toBe(true);
    for (const junk of ['#', '|', '**', '---']) expect(excerpt).not.toContain(junk);
  });

  it('skips an all-bold paragraph (a pseudo-heading)', () => {
    expect(noteExcerpt('**Attendees**\n\nWe met on Monday.')).toBe('We met on Monday.');
  });

  it('reduces inline bold, links and code to text and drops images', () => {
    const excerpt = noteExcerpt(
      'See **the plan** at [our site](https://example.com) with `npm test` ![diagram](x.png) done.',
    );

    expect(excerpt).not.toMatch(/[*`\[\]()]/);
    expect(excerpt).toContain('the plan');
    expect(excerpt).toContain('our site');
    expect(excerpt).toContain('npm test');
    expect(excerpt).not.toContain('diagram');
    expect(excerpt).not.toContain('example.com');
  });

  it('joins list items with a middle dot, or a space after sentence punctuation', () => {
    expect(noteExcerpt('- Alpha\n- Beta\n- Gamma')).toBe('Alpha · Beta · Gamma');
    expect(noteExcerpt('- First done.\n- Second done')).toBe('First done. Second done');
  });

  it('falls back to table rows for a table-only note, skipping the header row', () => {
    expect(noteExcerpt('| Field | Details |\n|---|---|\n| Meeting name | Dell-2 |')).toBe(
      'Meeting name: Dell-2',
    );
  });

  it('joins three or more table columns with a middle dot', () => {
    expect(noteExcerpt('| A | B | C |\n|---|---|---|\n| one | two | three |')).toBe(
      'one · two · three',
    );
  });

  it('falls back to headings when there is no prose or table', () => {
    expect(noteExcerpt('# Title\n\n## Section')).toBe('Title · Section');
  });

  it('returns an empty string for an empty body', () => {
    expect(noteExcerpt('')).toBe('');
  });

  it('keeps `# not a heading` literally for a plain_text body', () => {
    expect(noteExcerpt('# not a heading', 'plain_text')).toBe('# not a heading');
  });

  describe('truncation', () => {
    it('leaves short text unchanged', () => {
      expect(noteExcerpt('Short note.')).toBe('Short note.');
    });

    it('cuts a long body on a word boundary and ends with an ellipsis', () => {
      const body = Array.from({ length: 200 }, (_, i) => `word${i}`).join(' ');
      const excerpt = noteExcerpt(body);

      expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_CHARS + 1);
      expect(excerpt.endsWith('…')).toBe(true);
      const lastWord = excerpt.slice(0, -1).split(' ').pop()!;
      expect(body.split(' ')).toContain(lastWord);
    });
  });
});
