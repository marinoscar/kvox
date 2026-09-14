// =============================================================================
// Prompt assembly is PURE (issue #49, epic #45, docs/specs/notes.md §3.1)
// =============================================================================
//
// The assertion that matters most in this file is the boring one: the same
// inputs produce BYTE-IDENTICAL output. Spec §3.3 calls `assemblePrompt` twice
// for one generation — once in `POST /api/notes`'s own request handler to check
// the token budget before anything is created, and once inside `note.generate`
// to build the prompt actually sent. Any impurity at all (a clock, a random id,
// a `Set` iteration order) makes those two disagree about a note, which surfaces
// as "the request said it fits and the job says it does not" with nothing in
// either log to explain it.
// =============================================================================

import {
  CONTEXT_HEADING,
  LENGTH_HEADING,
  OUTPUT_FORMAT_HEADING,
  SOURCE_HEADING,
  STRUCTURE_HEADING,
  TONE_HEADING,
  assemblePrompt,
  parseTemplateStructure,
} from './prompt';

const base = {
  templateInstructions: 'Write meeting notes a person who missed the meeting can act on.',
  templateOutputFormat: 'Meeting notes',
  templateStructure: ['Overview', 'Decisions', 'Action items'],
  templateTone: 'Neutral and factual',
  templateLength: 'About 400 words',
  contextText: 'Attendees: Ana, Bo. Project codename: Kestrel.',
  sourceText: '**Ana** · 00:00\n\nWe should ship on Friday.',
};

describe('assemblePrompt — purity', () => {
  it('produces byte-identical output for identical inputs', () => {
    const first = assemblePrompt({ ...base });
    const second = assemblePrompt({ ...base });

    expect(first.systemPrompt).toBe(second.systemPrompt);
    expect(first.userContent).toBe(second.userContent);
  });

  it('is a function of its inputs alone — a later call with the same structure array contents matches', () => {
    const first = assemblePrompt({ ...base, templateStructure: ['A', 'B'] });
    const second = assemblePrompt({ ...base, templateStructure: ['A', 'B'] });

    expect(second).toEqual(first);
  });

  it('does not mutate its input', () => {
    const structure = ['Overview', 'Decisions'];
    const input = { ...base, templateStructure: structure };

    assemblePrompt(input);

    expect(structure).toEqual(['Overview', 'Decisions']);
    expect(input).toEqual({ ...base, templateStructure: structure });
  });
});

describe('assemblePrompt — ordering', () => {
  it('puts context BEFORE the source in the user content', () => {
    const { userContent } = assemblePrompt(base);

    expect(userContent.indexOf(CONTEXT_HEADING)).toBeGreaterThanOrEqual(0);
    expect(userContent.indexOf(CONTEXT_HEADING)).toBeLessThan(
      userContent.indexOf(SOURCE_HEADING),
    );
  });

  it('keeps the source LAST, so nothing follows it', () => {
    const { userContent } = assemblePrompt(base);

    expect(userContent.trimEnd().endsWith('We should ship on Friday.')).toBe(true);
  });

  it('keeps the template in the SYSTEM role and the source out of it', () => {
    const { systemPrompt, userContent } = assemblePrompt(base);

    expect(systemPrompt).toContain(base.templateInstructions);
    expect(systemPrompt).not.toContain('We should ship on Friday.');
    expect(userContent).not.toContain(base.templateInstructions);
  });

  it('orders the system block instructions → format → structure → tone → length', () => {
    const { systemPrompt } = assemblePrompt(base);

    const positions = [
      systemPrompt.indexOf(base.templateInstructions),
      systemPrompt.indexOf(OUTPUT_FORMAT_HEADING),
      systemPrompt.indexOf(STRUCTURE_HEADING),
      systemPrompt.indexOf(TONE_HEADING),
      systemPrompt.indexOf(LENGTH_HEADING),
    ];

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
  });
});

describe('assemblePrompt — every template field contributes', () => {
  it('renders the structure as an ordered list, in the stored order', () => {
    const { systemPrompt } = assemblePrompt(base);

    expect(systemPrompt).toContain('1. Overview');
    expect(systemPrompt).toContain('2. Decisions');
    expect(systemPrompt).toContain('3. Action items');
  });

  it('carries the output format, the tone and the length', () => {
    const { systemPrompt } = assemblePrompt(base);

    expect(systemPrompt).toContain(`${OUTPUT_FORMAT_HEADING} Meeting notes`);
    expect(systemPrompt).toContain(`${TONE_HEADING} Neutral and factual`);
    expect(systemPrompt).toContain(`${LENGTH_HEADING} About 400 words`);
  });

  it('changing ONE field changes the prompt — no field is silently dropped', () => {
    const reference = assemblePrompt(base).systemPrompt;

    const variants = [
      { ...base, templateInstructions: 'Something else entirely.' },
      { ...base, templateOutputFormat: 'Email' },
      { ...base, templateStructure: ['Only one section'] },
      { ...base, templateTone: 'Warm' },
      { ...base, templateLength: 'Two sentences' },
    ];

    for (const variant of variants) {
      expect(assemblePrompt(variant).systemPrompt).not.toBe(reference);
    }
  });

  it('OMITS an unset optional field rather than substituting a default', () => {
    const { systemPrompt } = assemblePrompt({
      ...base,
      templateTone: null,
      templateLength: null,
    });

    expect(systemPrompt).not.toContain(TONE_HEADING);
    expect(systemPrompt).not.toContain(LENGTH_HEADING);
    expect(systemPrompt).toContain(base.templateInstructions);
  });

  it('omits an empty structure rather than rendering an empty list', () => {
    const { systemPrompt } = assemblePrompt({ ...base, templateStructure: [] });

    expect(systemPrompt).not.toContain(STRUCTURE_HEADING);
  });
});

describe('assemblePrompt — context', () => {
  it('omits the context block entirely when there is no context', () => {
    const { userContent } = assemblePrompt({ ...base, contextText: null });

    expect(userContent).not.toContain(CONTEXT_HEADING);
    expect(userContent.startsWith(SOURCE_HEADING)).toBe(true);
  });

  it('treats a whitespace-only context as absent', () => {
    const blank = assemblePrompt({ ...base, contextText: '   \n  ' });
    const absent = assemblePrompt({ ...base, contextText: null });

    expect(blank).toEqual(absent);
  });

  it('always emits the source heading, even for an empty source', () => {
    const { userContent } = assemblePrompt({ ...base, sourceText: '' });

    expect(userContent).toContain(SOURCE_HEADING);
  });
});

describe('parseTemplateStructure', () => {
  it('reads a JSONB string array in order', () => {
    expect(parseTemplateStructure(['A', 'B', 'C'])).toEqual(['A', 'B', 'C']);
  });

  it('is total over garbage a rolled-back build could have written', () => {
    expect(parseTemplateStructure(null)).toEqual([]);
    expect(parseTemplateStructure(undefined)).toEqual([]);
    expect(parseTemplateStructure('Overview')).toEqual([]);
    expect(parseTemplateStructure({ sections: ['A'] })).toEqual([]);
    expect(parseTemplateStructure([1, null, 'A', '', '  ', { x: 1 }])).toEqual(['A']);
  });
});
