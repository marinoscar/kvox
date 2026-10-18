import { z } from 'zod';

import {
  PROMPTED_REPAIR_ISSUE_LIMIT,
  buildPromptedRepairInput,
  buildPromptedStructuredInstructions,
  parsePromptedStructuredAnswer,
  promptedJsonSchemaOf,
} from './prompted-structured.js';

// =============================================================================
// The pure half of the prompted structured-output path (#581)
// =============================================================================

const schema = z.object({ verdict: z.enum(['yes', 'no']), notes: z.array(z.object({ text: z.string() })).optional() });

describe('promptedJsonSchemaOf', () => {
  it('converts a Zod schema without the $schema document marker', () => {
    const json = promptedJsonSchemaOf(schema);
    expect(json).toMatchObject({ type: 'object', properties: { verdict: { enum: ['yes', 'no'] } } });
    expect(json).not.toHaveProperty('$schema');
  });

  it('prefers the caller JSON Schema as it is', () => {
    const given = { type: 'object', properties: { a: { type: 'string' } }, additionalProperties: false };
    expect(promptedJsonSchemaOf(schema, given)).toBe(given);
  });
});

describe('buildPromptedStructuredInstructions', () => {
  const jsonSchema = { type: 'object', properties: { verdict: { type: 'string' } } };

  it('is the system prompt, a blank line, then the generic block with the named pretty-printed schema', () => {
    const out = buildPromptedStructuredInstructions({ system: 'Judge it.', schemaName: 'verdict_schema', jsonSchema });
    expect(out.startsWith('Judge it.\n\n')).toBe(true);
    expect(out).toContain('JSON Schema, named "verdict_schema":');
    expect(out.endsWith(JSON.stringify(jsonSchema, null, 2))).toBe(true);
    expect(out).toMatch(/single JSON value only/);
    expect(out).toMatch(/no code fence/);
  });

  it('is only the block when the system prompt is empty', () => {
    const out = buildPromptedStructuredInstructions({ system: '', schemaName: 's', jsonSchema });
    expect(out.startsWith('Answer with a single JSON value only')).toBe(true);
  });

  it('names no KVox concept', () => {
    const out = buildPromptedStructuredInstructions({ system: '', schemaName: 's', jsonSchema });
    expect(out).not.toMatch(/kvox|transcript|meeting|note/i);
  });
});

describe('parsePromptedStructuredAnswer', () => {
  const parse = (text: string) => parsePromptedStructuredAnswer(text, [schema]);

  it.each([
    ['plain JSON', '{"verdict":"yes"}'],
    ['surrounding whitespace', '  \n{"verdict":"yes"}\n\n '],
    ['a json fence', '```json\n{"verdict":"yes"}\n```'],
    ['a bare fence', '```\n{"verdict":"yes"}\n```'],
    ['a fence with an upper-case tag', '```JSON\n{"verdict":"yes"}\n```'],
    ['a fence with CRLF', '```json\r\n{"verdict":"yes"}\r\n```'],
    ['a fence with no newline before the closer', '```json\n{"verdict":"yes"}```'],
    ['a fenced answer with outer whitespace', '\n  ```json\n  {"verdict":"yes"}\n```  \n'],
  ])('accepts %s', (_what, text) => {
    expect(parse(text)).toEqual({ ok: true, value: { verdict: 'yes' } });
  });

  it.each([
    ['prose before the JSON', 'Sure! {"verdict":"yes"}'],
    ['prose after the fence', '```json\n{"verdict":"yes"}\n```\nHope that helps'],
    ['an empty answer', ''],
    ['a truncated object', '{"verdict":"ye'],
    ['two fences', '```json\n{"verdict":"yes"}\n```\n```json\n{"verdict":"no"}\n```'],
  ])('reports %s as not JSON', (_what, text) => {
    const result = parse(text);
    expect(result).toMatchObject({ ok: false, notJson: true });
    expect((result as { issues: Array<{ code: string; path: unknown[] }> }).issues[0]).toMatchObject({ code: 'invalid_json', path: [] });
  });

  it('reports a schema mismatch as well-formed JSON with path, code and message', () => {
    const result = parse('{"verdict":"maybe","notes":[{"text":3}]}');
    expect(result).toMatchObject({ ok: false, notJson: false });
    const issues = (result as { issues: Array<{ path: Array<string | number>; code: string; message: string }> }).issues;
    expect(issues[0]).toMatchObject({ path: ['verdict'], code: 'invalid_value' });
    expect(typeof issues[0].message).toBe('string');
  });

  it('validates with every schema in order and returns the last schema output', () => {
    const constrained = z.object({ verdict: z.string() });
    const callers = z.object({ verdict: z.string().transform((v) => v.toUpperCase()) });
    expect(parsePromptedStructuredAnswer('{"verdict":"yes"}', [constrained, callers])).toEqual({ ok: true, value: { verdict: 'YES' } });

    const strictFirst = z.object({ verdict: z.literal('never') });
    const failed = parsePromptedStructuredAnswer('{"verdict":"yes"}', [strictFirst, callers]);
    expect(failed).toMatchObject({ ok: false, notJson: false });
  });
});

describe('buildPromptedRepairInput', () => {
  const base = { user: 'THE USER TEXT', schemaName: 'verdict_schema', answer: 'PREVIOUS ANSWER' };

  it('is the user text, a separator, the previous answer, the problems and the ask', () => {
    const out = buildPromptedRepairInput({
      ...base,
      issues: [
        { path: ['notes', 0, 'text'], code: 'invalid_type', message: 'Expected string' },
        { path: [], code: 'invalid_json', message: 'Unexpected token' },
      ],
    });
    expect(typeof out).toBe('string');
    expect(out.startsWith('THE USER TEXT\n\n---\n\n')).toBe(true);
    expect(out).toContain('"verdict_schema"');
    expect(out).toContain('PREVIOUS ANSWER');
    expect(out).toContain('- $.notes[0].text: Expected string');
    expect(out).toContain('- $: Unexpected token');
    expect(out.endsWith('Answer again with the corrected JSON value only.')).toBe(true);
  });

  it('lists at most the limit and counts the rest', () => {
    const issues = Array.from({ length: PROMPTED_REPAIR_ISSUE_LIMIT + 5 }, (_, i) => ({ path: [`f${i}`], code: 'x', message: 'bad' }));
    const out = buildPromptedRepairInput({ ...base, issues });
    expect(out.match(/^- \$\./gm)).toHaveLength(PROMPTED_REPAIR_ISSUE_LIMIT);
    expect(out).toContain('- ...and 5 more');
  });

  it('caps a long issue message and says so when there are no issues', () => {
    const long = buildPromptedRepairInput({ ...base, issues: [{ path: ['a'], code: 'x', message: 'm'.repeat(1000) }] });
    expect(long).toContain(`${'m'.repeat(200)}...`);
    expect(long).not.toContain('m'.repeat(201));
    expect(buildPromptedRepairInput({ ...base, issues: [] })).toContain('- the answer could not be read');
  });
});
