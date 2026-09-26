import { ATTRIBUTE_KINDS, SENSITIVITIES } from '@app/shared/ontology';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// User-defined attribute definitions (#355, epic #344; docs/specs/ontology.md §17.3)
// =============================================================================
//
// A user's own attributes on an entity type ("Nickname" on Person). The key is
// SERVER-GENERATED (`u_` + ten `[a-z0-9]`) and permanent — `props` store values
// under it, so the label stays renameable without touching a single row.
// Deprecate, never delete: a deleted definition would leave stored values with
// nothing to render them.
//
// Kind-specific rules (choices for selects, target types for `entity_ref`,
// options only for those kinds, a hint for an extractable attribute) need the
// caller's effective schema and are checked by the service, not here.
// =============================================================================

const choiceSchema = z.object({
  value: z.string().trim().min(1).max(60).describe('The stored value. Permanent once used.'),
  label: z.string().trim().min(1).max(80).describe('The label a picker shows. Renameable.'),
});

export const attributeDefOptionsSchema = z
  .object({
    choices: z
      .array(choiceSchema)
      .min(1)
      .max(100)
      .refine((choices) => new Set(choices.map((c) => c.value)).size === choices.length, {
        message: 'Choice values must be unique.',
      })
      .optional()
      .describe('`select`/`multi_select` only: the permitted values, in display order.'),
    targetTypes: z
      .array(z.string().min(1))
      .min(1)
      .max(50)
      .optional()
      .describe('`entity_ref` only: the entity types a reference may point at.'),
  })
  .describe('Kind-specific options. Sent only for `select`, `multi_select` and `entity_ref`.');

const sensitivitySchema = z
  .enum(SENSITIVITIES)
  .nullable()
  .describe('How private a value is (§5.6). `null` inherits the entity type\'s default.');

const immutable = (field: string) =>
  z
    .never({ error: `${field} cannot be changed after an attribute is created.` })
    .optional()
    .describe(`Not accepted: \`${field}\` is immutable.`);

export const createAttributeDefSchema = z.object({
  entityType: z.string().trim().min(1).max(80).describe('An entity type key of your effective schema.'),
  label: z.string().trim().min(1).max(80),
  kind: z.enum(ATTRIBUTE_KINDS).describe('Immutable once created.'),
  options: attributeDefOptionsSchema.optional(),
  extractable: z.boolean().default(false).describe('Whether extraction may ask the model for this value.'),
  extractionHint: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .nullable()
    .optional()
    .describe('Prompt copy for the model. Required when `extractable` is true.'),
  sensitivity: sensitivitySchema.optional(),
  sortOrder: z.number().int().min(0).max(10000).optional(),
});

export type CreateAttributeDefDto = z.infer<typeof createAttributeDefSchema>;
export class CreateAttributeDefBodyDto extends createZodDto(createAttributeDefSchema) {}

export const patchAttributeDefSchema = z
  .object({
    label: z.string().trim().min(1).max(80).optional(),
    options: attributeDefOptionsSchema.optional().describe('Choices may be added or relabelled, never removed.'),
    extractable: z.boolean().optional(),
    extractionHint: z.string().trim().min(1).max(500).nullable().optional(),
    sensitivity: sensitivitySchema.optional(),
    sortOrder: z.number().int().min(0).max(10000).optional(),
    deprecated: z.boolean().optional().describe('`true` deprecates (hidden from forms and extraction, values kept); `false` restores.'),
    kind: immutable('kind'),
    entityType: immutable('entityType'),
    key: immutable('key'),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export type PatchAttributeDefDto = z.infer<typeof patchAttributeDefSchema>;
export class PatchAttributeDefBodyDto extends createZodDto(patchAttributeDefSchema) {}

export const attributeDefListQuerySchema = z.object({
  entityType: z.string().trim().min(1).max(80).optional().describe('Only definitions on this entity type.'),
  /**
   * `z.enum(['true','false'])`, never `z.coerce.boolean()` — `Boolean('false')`
   * is `true` (see `ai-model-discovery.dto.ts`).
   */
  includeDeprecated: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional()
    .describe('Include deprecated definitions. Default false.'),
});

export type AttributeDefListQuery = z.infer<typeof attributeDefListQuerySchema>;

export const graphAttributeDefSchema = z
  .object({
    id: z.uuid(),
    entityType: z.string(),
    key: z.string().describe('`u_` plus ten lowercase alphanumerics. Server-generated and permanent.'),
    label: z.string(),
    kind: z.enum(ATTRIBUTE_KINDS),
    options: attributeDefOptionsSchema.nullable(),
    extractable: z.boolean(),
    extractionHint: z.string().nullable(),
    sensitivity: z.enum(SENSITIVITIES).nullable(),
    sortOrder: z.number().int(),
    deprecatedAt: z.string().nullable().describe('ISO 8601, or null while live.'),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .describe('One of your own attribute definitions.');

export type GraphAttributeDefResponse = z.infer<typeof graphAttributeDefSchema>;
export class GraphAttributeDefDto extends createZodDto(graphAttributeDefSchema) {}

export const graphAttributeDefListSchema = z.object({
  items: z.array(graphAttributeDefSchema).describe('Ordered by entity type, sort order, then creation time.'),
});
export class GraphAttributeDefListDto extends createZodDto(graphAttributeDefListSchema) {}
