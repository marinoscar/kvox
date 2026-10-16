import {
  MarkdownTranscriptExporter,
  escapeMarkdown,
  groupTurns,
  renderFrontMatter,
  yamlString,
} from './markdown.exporter';
import { TranscriptExporterRegistry } from './transcript-exporter.interface';
import { fixtureDocument } from './__fixtures__/document';
import { renderToString } from './__fixtures__/collect';

// =============================================================================
// The Markdown export (issue #28, epic #19, spec §8.3)
// =============================================================================
//
// Two acceptance criteria live here: "Markdown escaping and front matter
// tests". The escaping half matters more than it looks — an unescaped `*` in
// somebody's spoken words starts emphasis that swallows the rest of the
// paragraph, and a segment beginning with `"# "` becomes a heading.
// =============================================================================

function exporter(): MarkdownTranscriptExporter {
  const instance = new MarkdownTranscriptExporter(new TranscriptExporterRegistry());

  instance.onModuleInit();

  return instance;
}

describe('escapeMarkdown', () => {
  it.each([
    ['a * b', 'a \\* b'],
    ['snake_case_name', 'snake\\_case\\_name'],
    ['use `code` here', 'use \\`code\\` here'],
    ['a [link] there', 'a \\[link\\] there'],
    ['tilde ~strike~', 'tilde \\~strike\\~'],
    ['a | b', 'a \\| b'],
    ['<html>', '\\<html\\>'],
  ])('escapes inline specials: %s', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it('escapes a backslash first, so it does not double-escape the others', () => {
    expect(escapeMarkdown('a \\ b * c')).toBe('a \\\\ b \\* c');
  });

  it('escapes a heading marker at the start of a line', () => {
    expect(escapeMarkdown('# Not a heading')).toBe('\\# Not a heading');
  });

  it.each([
    ['- a list?', '\\- a list?'],
    ['+ also not', '\\+ also not'],
    ['1. numbered speech', '\\1. numbered speech'],
    ['2) or this', '\\2) or this'],
    ['=== underline', '\\=== underline'],
  ])('escapes a block opening: %s', (input, expected) => {
    expect(escapeMarkdown(input)).toBe(expected);
  });

  it('leaves a hyphen alone in the middle of a line, so speech stays readable', () => {
    // Escaping every hyphen and full stop produces a file that is technically
    // correct and unreadable as plain text — half the point of Markdown.
    expect(escapeMarkdown('a well-known fact. Really.')).toBe('a well-known fact. Really.');
  });

  it('applies the block rule per line for multi-line text', () => {
    expect(escapeMarkdown('one\n# two')).toBe('one\n\\# two');
  });

  it('leaves ordinary text untouched', () => {
    expect(escapeMarkdown('Just a normal sentence.')).toBe('Just a normal sentence.');
  });
});

describe('yamlString', () => {
  it('always quotes, so a title of `yes` is not read as a boolean', () => {
    expect(yamlString('yes')).toBe('"yes"');
    expect(yamlString('2026-01-01')).toBe('"2026-01-01"');
  });

  it('escapes quotes and backslashes, NOT Markdown specials', () => {
    // A `*` inside a quoted YAML scalar is literal; backslash-escaping it here
    // would put a visible backslash in every tool that imports the file.
    expect(yamlString('a "quoted" *thing*')).toBe('"a \\"quoted\\" *thing*"');
    expect(yamlString('back\\slash')).toBe('"back\\\\slash"');
  });

  it('escapes a newline rather than breaking the document', () => {
    expect(yamlString('two\nlines')).toBe('"two\\nlines"');
  });
});

describe('renderFrontMatter', () => {
  const front = renderFrontMatter(fixtureDocument());

  it('is fenced', () => {
    expect(front.startsWith('---\n')).toBe(true);
    expect(front).toContain('\n---\n');
  });

  it('carries the title, date, duration, version and speakers spec §8.3 names', () => {
    expect(front).toContain('title: "Weekly sync — Sept 10"');
    expect(front).toContain('date: "2026-09-10T15:04:22.000Z"');
    expect(front).toContain('duration: "24s"');
    expect(front).toContain('version: 4');
    expect(front).toContain('speakers:');
    expect(front).toContain('  - "José Núñez"');
  });

  it('omits the language line entirely when there is none', () => {
    expect(renderFrontMatter(fixtureDocument({ language: null }))).not.toContain('language:');
  });

  it('omits the author line for the AI original', () => {
    expect(renderFrontMatter(fixtureDocument({ author: null }))).not.toContain('author:');
  });
});

describe('groupTurns', () => {
  const doc = fixtureDocument();

  it('is one turn per segment when merging is off', () => {
    expect(groupTurns(doc, false)).toHaveLength(4);
  });

  it('collapses consecutive same-speaker segments when merging is on', () => {
    const turns = groupTurns(doc, true);

    expect(turns).toHaveLength(2);
    expect(turns[0].text).toBe(
      "Let's get started — thanks everyone. # Not a heading, just speech.",
    );
  });

  it('labels a merged run with the FIRST segment\'s start', () => {
    // The last segment's start would put a timestamp on the page pointing at
    // the middle of the text beside it.
    expect(groupTurns(doc, true)[1].startMs).toBe(8_000);
  });
});

describe('MarkdownTranscriptExporter', () => {
  it('registers itself', () => {
    const registry = new TranscriptExporterRegistry();

    new MarkdownTranscriptExporter(registry).onModuleInit();

    expect(registry.get('markdown')?.extension).toBe('md');
  });

  it('renders `**Speaker** · 00:01:23` paragraphs', async () => {
    const output = await renderToString(exporter(), fixtureDocument());

    expect(output).toContain('**José Núñez** · 00:00:00');
    expect(output).toContain('**Priya \\*Patel\\*** · 00:00:08');
  });

  it('escapes the title in the heading and the segment text in the body', async () => {
    const output = await renderToString(exporter(), fixtureDocument());

    expect(output).toContain('\\# Not a heading, just speech.');
    expect(output).toContain('I have a \\*note\\* about the \\_budget\\_.');
    expect(output).toContain('And a \\[link\\] with \\`code\\` in it.');
  });

  it('drops the timestamps when asked', async () => {
    const output = await renderToString(exporter(), fixtureDocument(), {
      includeTimestamps: false,
    });

    expect(output).toContain('**José Núñez**\n');
    expect(output).not.toContain('· 00:00:00');
  });

  it('merges consecutive turns when asked', async () => {
    const output = await renderToString(exporter(), fixtureDocument(), {
      mergeConsecutive: true,
    });

    expect(output.match(/\*\*José Núñez\*\*/g)).toHaveLength(1);
  });

  it('renders a document with no segments as front matter and a heading', async () => {
    const output = await renderToString(exporter(), fixtureDocument({ segments: [] }));

    expect(output).toContain('# Weekly sync — Sept 10');
    expect(output).not.toContain('·');
  });

  it('names an unknown speaker rather than rendering `undefined`', async () => {
    const doc = fixtureDocument();
    const output = await renderToString(exporter(), { ...doc, speakers: [] });

    expect(output).toContain('**Unknown speaker**');
  });
});
