// =============================================================================
// The four structured schemas survive `z.fromJSONSchema` (issue #475, epic #472)
// =============================================================================
//
// `createKvoxAi(...).generateStructured` (`@marinoscar/kvox-ai`, the bound `KVOX_AI`) turns a caller's strict JSON Schema into Zod
// with `z.fromJSONSchema` (the call the platform's own HTTP layer makes); the
// platform converts it BACK with `z.toJSONSchema` for the wire and validates the
// model's answer with the Zod form. The risk the issue names is a strict-mode
// construct kvox uses that does not survive the trip. This spec runs the four
// schemas this app sends (extraction, entity adjudication, item adjudication, entity
// digest) through the exact pair of calls and pins what must stay true:
//
//   * neither call throws;
//   * every object is still closed and still requires every key it declares;
//   * every `description` survives (the output caps are descriptions, never
//     `maxItems`, and they ride on them);
//   * every enumerated value survives, and an ontology type or item kind is not lost;
//   * a known-good answer still validates, and an answer with an extra key does not.
//
// WHAT CHANGES, AND IS ACCEPTED (semantically identical): `enum: [x]` becomes
// `const: x`, `type: [T, 'null']` becomes `anyOf: [{type: T}, {type: 'null'}]`, an
// empty `required: []` is omitted, `$schema` is dropped by the platform, and key
// order moves. Whether a given vendor gateway accepts the converted spelling is the
// one thing a unit test cannot show; see the issue's gateway note.
//
// It lives under `test/` because it reads graph code, and `ai-port/` is a base
// directory that must not import a domain one.
// =============================================================================

import { z } from 'zod';

import { buildExtractionOutputSchema, buildAdjudicationOutputSchema, buildItemAdjudicationOutputSchema, DIGEST_RESPONSE_SCHEMA } from '../graph/package-internals';
import { goodAnswer, makeContext, schemaFor } from '../graph/extraction-fixtures';

type Node = Record<string, unknown>;

function roundTrip(schema: Node): { zod: z.ZodType; back: Node } {
  const zod = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  const { $schema: _ignored, ...back } = z.toJSONSchema(zod, { unrepresentable: 'throw' });
  return { zod, back };
}

/** Every node of a schema tree, depth first. */
function nodes(root: unknown, out: Node[] = []): Node[] {
  if (Array.isArray(root)) {
    for (const child of root) nodes(child, out);
  } else if (typeof root === 'object' && root !== null) {
    out.push(root as Node);
    for (const child of Object.values(root)) nodes(child, out);
  }
  return out;
}

const isObjectNode = (n: Node): boolean =>
  n.type === 'object' && typeof n.properties === 'object' && n.properties !== null;

/** The string values a schema can take: every `enum` member and `const`. */
function enumeratedValues(root: unknown): string[] {
  const values = new Set<string>();
  for (const node of nodes(root)) {
    if (Array.isArray(node.enum)) {
      for (const value of node.enum) if (typeof value === 'string') values.add(value);
    }
    if (typeof node.const === 'string') values.add(node.const);
  }
  return [...values].sort();
}

function descriptions(root: unknown): string[] {
  return nodes(root)
    .map((node) => node.description)
    .filter((value): value is string => typeof value === 'string')
    .sort();
}

const CASES: Array<{ name: string; build: () => Node }> = [
  { name: 'extraction (all domains)', build: () => buildExtractionOutputSchema(makeContext()) as Node },
  {
    name: 'extraction (core domain only)',
    build: () =>
      buildExtractionOutputSchema(makeContext({ effectiveSchema: schemaFor(['core']) })) as Node,
  },
  { name: 'adjudication', build: () => buildAdjudicationOutputSchema() as Node },
  { name: 'item adjudication', build: () => buildItemAdjudicationOutputSchema() as Node },
  { name: 'digest', build: () => DIGEST_RESPONSE_SCHEMA as Node },
];

describe('structured schemas through z.fromJSONSchema (#475)', () => {
  it.each(CASES)('$name converts both ways without throwing', ({ build }) => {
    expect(() => roundTrip(build())).not.toThrow();
  });

  it.each(CASES)('$name keeps every object closed and every key required', ({ build }) => {
    const { back } = roundTrip(build());

    for (const node of nodes(back).filter(isObjectNode)) {
      const keys = Object.keys(node.properties as Node).sort();
      expect(node.additionalProperties).toBe(false);
      // The converter omits an empty `required`; an object with keys lists them all.
      expect([...((node.required as string[] | undefined) ?? [])].sort()).toEqual(keys);
    }
  });

  it.each(CASES)('$name keeps every description (the output caps ride on them)', ({ build }) => {
    const original = build();
    const { back } = roundTrip(original);

    expect(descriptions(back)).toEqual(descriptions(original));
  });

  it.each(CASES)('$name keeps every enumerated value', ({ build }) => {
    const original = build();
    const { back } = roundTrip(original);

    expect(enumeratedValues(back)).toEqual(enumeratedValues(original));
  });

  it('accepts a known-good extraction answer and rejects an extra key', () => {
    const { zod } = roundTrip(buildExtractionOutputSchema(makeContext()) as Node);

    expect(zod.safeParse(goodAnswer()).success).toBe(true);
    expect(zod.safeParse({ ...goodAnswer(), surprise: true }).success).toBe(false);
  });

  it('accepts a digest, an adjudication and an item adjudication answer, and rejects a bad enum', () => {
    expect(
      roundTrip(DIGEST_RESPONSE_SCHEMA as Node).zod.safeParse({
        statements: [{ text: 'Kicked off.', factRefs: ['F1'] }],
      }).success,
    ).toBe(true);

    const adjudication = roundTrip(buildAdjudicationOutputSchema() as Node).zod;
    expect(
      adjudication.safeParse({ verdicts: [{ pairId: 'p1', verdict: 'same', rationale: 'Same email.' }] })
        .success,
    ).toBe(true);
    expect(
      adjudication.safeParse({ verdicts: [{ pairId: 'p1', verdict: 'maybe', rationale: 'x' }] }).success,
    ).toBe(false);

    const item = roundTrip(buildItemAdjudicationOutputSchema() as Node).zod;
    expect(
      item.safeParse({
        verdicts: [
          {
            pairId: 'p1',
            verdict: 'supersedes',
            changes: { status: null, dueAt: '2026-01-02' },
            rationale: 'Moved.',
          },
        ],
      }).success,
    ).toBe(true);
  });
});
