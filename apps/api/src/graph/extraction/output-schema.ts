// =============================================================================
// The kg.extract structured-output schema (#363, epic #346; ontology.md §6, §17.1)
// =============================================================================
//
// PURE. Two views of ONE shape, both built from the same offered schema:
//
//   - `buildExtractionOutputSchema(ctx)` — the strict JSON Schema handed to
//     `AiProvider.generateStructured` (every property required, nullable via
//     `type: [x, 'null']`, `additionalProperties: false`, only the keywords
//     #358's `assertStrictJsonSchema` permits — `enum: [key]`, never `const`).
//     Entities, relations and items are each an `anyOf` with one object per
//     offered type, carrying that type's own `props` object from #350's
//     `buildPropsJsonSchema`. (Items are `anyOf` per item type too, rather than
//     one object with a `kind` enum, because item types carry different props —
//     `Decision.rejectedOption`, a user's own attributes.)
//   - `rawExtractionSchema` — the Zod ENVELOPE the answer is parsed with before
//     anything else. It checks structure only (arrays of objects with the right
//     scalar fields); per-row type and props checks are the validator's, row by
//     row, so one bad row is dropped and counted rather than failing the whole
//     proposal. A malformed envelope is `invalid_output`.
// =============================================================================

import { buildPropsJsonSchema, type EffectiveEntityType } from '@app/shared/ontology';
import { z } from 'zod';

import type { JsonSchema } from '../../ai/providers/ai-provider.interface';
import type { ExtractionContext } from './extraction-context';

export const EXTRACTION_SCHEMA_NAME = 'kg_extraction';

const PRECISIONS = ['day', 'month', 'year', 'unknown'];

const ALWAYS_NULL: JsonSchema = { type: 'null', description: 'Always null for this kind.' };

const nullableString = (description: string): JsonSchema => ({ type: ['string', 'null'], description });

function citeSchema(): JsonSchema {
  return {
    type: 'array',
    description: 'Where this row is stated. At least one.',
    items: {
      type: 'object',
      properties: {
        source: { type: 'string', description: 'An `s#` transcript line id or `N` for the note — only ids you were given.' },
        quote: { type: 'string', description: 'An exact quote of at most 200 characters from that line or the note.' },
      },
      required: ['source', 'quote'],
      additionalProperties: false,
    },
  };
}

function object(properties: Record<string, JsonSchema>, description?: string): JsonSchema {
  return {
    type: 'object',
    ...(description ? { description } : {}),
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function endpoint(description: string, nullable = false): JsonSchema {
  return nullable ? nullableString(description) : { type: 'string', description };
}

function entitySchema(ctx: ExtractionContext, t: EffectiveEntityType): JsonSchema {
  return object(
    {
      ref: { type: 'string', description: 'A known entity\'s `k#` when this is that entity, else a new `e#`.' },
      type: { type: 'string', enum: [t.key] },
      label: { type: 'string', description: 'The name as the source gives it.' },
      aliases: { type: 'array', items: { type: 'string' }, description: 'Other names used for it in the source.' },
      props: buildPropsJsonSchema(ctx.effectiveSchema, t.key),
      evidence: citeSchema(),
    },
    `${t.label}: ${t.description}`,
  );
}

function temporalProps(): Record<string, JsonSchema> {
  return {
    validFrom: nullableString('YYYY-MM-DD, or null.'),
    validTo: nullableString('YYYY-MM-DD, or null.'),
    precision: { type: 'string', enum: PRECISIONS, description: 'How exact the source is about the dates. `unknown` rather than a guess.' },
  };
}

function relationSchema(ctx: ExtractionContext, r: ExtractionContext['offered']['relationTypes'][number]): JsonSchema {
  return object(
    {
      type: { type: 'string', enum: [r.type.key] },
      from: endpoint(`A ${r.from.join('|')}: a \`k#\`, an \`e#\`${r.from.includes('Meeting') ? ', or `meeting`' : ''}.`),
      to: endpoint(`A ${r.to.join('|')}: a \`k#\`, an \`e#\`${r.to.includes('Meeting') ? ', or `meeting`' : ''}.`),
      props: buildPropsJsonSchema(ctx.effectiveSchema, r.type.key, { relation: true }),
      ...temporalProps(),
      evidence: citeSchema(),
    },
    `${r.type.key}: ${r.type.description}`,
  );
}

function itemSchema(ctx: ExtractionContext, t: EffectiveEntityType): JsonSchema {
  const kind = t.itemKind as string;
  const isCommitment = kind === 'commitment';
  const statuses = isCommitment ? ['open', 'done', 'dropped'] : [];
  return object(
    {
      kind: { type: 'string', enum: [kind] },
      title: { type: 'string', description: 'A short title.' },
      statement: { type: 'string', description: 'The fact as one self-contained sentence.' },
      subject: endpoint(
        `What it is about (${(t.subjectTypes ?? []).join('|')}): a \`k#\` or \`e#\`${t.subjectRequired ? '' : ', or null'}.`,
        true,
      ),
      owner: isCommitment ? endpoint('The Person who owes it: a `k#` or `e#`.') : ALWAYS_NULL,
      counterparty: isCommitment
        ? endpoint('The Person or Organization it is owed to (`k#`/`e#`), or null.', true)
        : ALWAYS_NULL,
      status:
        statuses.length > 0
          ? { type: ['string', 'null'], enum: [...statuses, null], description: 'Commitment status.' }
          : ALWAYS_NULL,
      occurredAt: nullableString('When it happened or was stated (YYYY-MM-DD), or null.'),
      dueAt: isCommitment ? nullableString('Due date (YYYY-MM-DD), or null.') : ALWAYS_NULL,
      ...temporalProps(),
      sensitivity:
        kind === 'person_fact'
          ? { type: ['string', 'null'], enum: ['business', 'personal', 'sensitive', null], description: 'How sensitive this fact is.' }
          : ALWAYS_NULL,
      props: buildPropsJsonSchema(ctx.effectiveSchema, t.key),
      evidence: citeSchema(),
    },
    `${t.label}: ${t.description}`,
  );
}

function arrayOf(variants: JsonSchema[]): JsonSchema {
  return { type: 'array', items: variants.length === 1 ? variants[0] : { anyOf: variants } };
}

/**
 * The strict JSON Schema for one run. A section with nothing offered (every
 * relation type excluded by guidance, say) is left out entirely rather than
 * sent as an array of nothing; the envelope parser defaults it to `[]`.
 */
export function buildExtractionOutputSchema(ctx: ExtractionContext): JsonSchema {
  const properties: Record<string, JsonSchema> = {
    meeting: object(
      { topics: { type: 'array', items: { type: 'string' }, description: 'Recurring subjects discussed that are not entities.' } },
      'About the meeting itself. It is created by the system; do not propose it as an entity.',
    ),
  };
  if (ctx.offered.entityTypes.length > 0) {
    properties.entities = arrayOf(ctx.offered.entityTypes.map((t) => entitySchema(ctx, t)));
  }
  if (ctx.offered.relationTypes.length > 0) {
    properties.relations = arrayOf(ctx.offered.relationTypes.map((r) => relationSchema(ctx, r)));
  }
  if (ctx.offered.itemTypes.length > 0) {
    properties.items = arrayOf(ctx.offered.itemTypes.map((t) => itemSchema(ctx, t)));
  }
  return object(properties);
}

// -----------------------------------------------------------------------------
// The Zod envelope
// -----------------------------------------------------------------------------

const cite = z.object({ source: z.string(), quote: z.string() });
const props = z.record(z.string(), z.unknown()).nullable().default({});
const nullableStr = z.string().nullable().default(null);

export const rawEntitySchema = z.object({
  ref: z.string(),
  type: z.string(),
  label: z.string(),
  aliases: z.array(z.string()).default([]),
  props,
  evidence: z.array(cite).default([]),
});

export const rawRelationSchema = z.object({
  type: z.string(),
  from: z.string(),
  to: z.string(),
  props,
  validFrom: nullableStr,
  validTo: nullableStr,
  precision: z.string().nullable().default('unknown'),
  evidence: z.array(cite).default([]),
});

export const rawItemSchema = z.object({
  kind: z.string(),
  title: z.string(),
  statement: z.string(),
  subject: nullableStr,
  owner: nullableStr,
  counterparty: nullableStr,
  status: nullableStr,
  occurredAt: nullableStr,
  dueAt: nullableStr,
  validFrom: nullableStr,
  validTo: nullableStr,
  precision: z.string().nullable().default('unknown'),
  sensitivity: nullableStr,
  props,
  evidence: z.array(cite).default([]),
});

export const rawExtractionSchema = z.object({
  meeting: z.object({ topics: z.array(z.string()).default([]) }).default({ topics: [] }),
  entities: z.array(rawEntitySchema).default([]),
  relations: z.array(rawRelationSchema).default([]),
  items: z.array(rawItemSchema).default([]),
});

export type RawExtraction = z.infer<typeof rawExtractionSchema>;
export type RawEntity = z.infer<typeof rawEntitySchema>;
export type RawRelation = z.infer<typeof rawRelationSchema>;
export type RawItem = z.infer<typeof rawItemSchema>;
export type RawCite = z.infer<typeof cite>;
