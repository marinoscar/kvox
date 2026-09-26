import { assertStrictJsonSchema } from '../../ai/structured/strict-json-schema';
import { goodAnswer, makeContext, schemaFor } from '../../../test/graph/extraction-fixtures';
import { buildExtractionOutputSchema, rawExtractionSchema } from './output-schema';

type Node = Record<string, unknown>;

/** Every object subschema in a schema tree. */
function objects(node: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(node)) {
    for (const n of node) objects(n, out);
    return out;
  }
  if (typeof node !== 'object' || node === null) return out;
  const n = node as Node;
  if (n.type === 'object' || (Array.isArray(n.type) && n.type.includes('object'))) out.push(n);
  for (const v of Object.values(n)) objects(v, out);
  return out;
}

function enumValues(node: unknown, key: string): string[] {
  const found: string[] = [];
  const walk = (n: unknown) => {
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n !== 'object' || n === null) return;
    const obj = n as Node;
    const props = obj.properties as Node | undefined;
    const prop = props?.[key] as Node | undefined;
    if (prop && Array.isArray(prop.enum)) found.push(...(prop.enum as string[]));
    Object.values(obj).forEach(walk);
  };
  walk(node);
  return found;
}

describe('buildExtractionOutputSchema (#363)', () => {
  it('passes #358\'s strict-mode pre-flight', () => {
    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(makeContext()))).not.toThrow();
    expect(() => assertStrictJsonSchema(buildExtractionOutputSchema(makeContext({ effectiveSchema: schemaFor(['core']) })))).not.toThrow();
  });

  it('every object is closed and requires every one of its keys', () => {
    for (const obj of objects(buildExtractionOutputSchema(makeContext()))) {
      expect(obj.additionalProperties).toBe(false);
      expect([...(obj.required as string[])].sort()).toEqual(Object.keys(obj.properties as Node).sort());
    }
  });

  it('offers exactly the offered types, relations and item kinds', () => {
    const schema = buildExtractionOutputSchema(makeContext());
    const types = enumValues((schema.properties as Node).entities, 'type');
    expect(types.sort()).toEqual(['Organization', 'Person', 'Project']);
    const relations = enumValues((schema.properties as Node).relations, 'type');
    expect(relations).toEqual(expect.arrayContaining(['WORKS_FOR', 'ATTENDED', 'DISCUSSED']));
    expect(relations).not.toContain('ABOUT');
    expect(enumValues((schema.properties as Node).items, 'kind').sort()).toEqual(['claim', 'commitment', 'decision', 'person_fact']);
  });

  it('leaves out a type excluded by guidance and every type of a disabled domain', () => {
    const guided = buildExtractionOutputSchema(
      makeContext({ guidance: { pinnedEntityIds: [], entityTypes: ['Person'], relationTypes: [], instructions: '' } }),
    );
    expect(enumValues((guided.properties as Node).entities, 'type')).toEqual(['Person']);
    expect((guided.properties as Node).relations).toBeUndefined();
    expect((guided.properties as Node).items).toBeUndefined();

    const core = JSON.stringify(buildExtractionOutputSchema(makeContext({ effectiveSchema: schemaFor(['core']) })));
    for (const hidden of ['Project', 'Commitment', 'WORKS_FOR', 'rejectedOption']) expect(core).not.toContain(hidden);
  });

  it('the envelope parser accepts a well-formed answer and defaults a section that was not offered', () => {
    expect(rawExtractionSchema.safeParse(goodAnswer()).success).toBe(true);
    const parsed = rawExtractionSchema.parse({ meeting: { topics: [] }, entities: [] });
    expect(parsed.relations).toEqual([]);
    expect(parsed.items).toEqual([]);
  });
});
