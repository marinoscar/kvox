import {
  ATTRIBUTE_KINDS,
  DOMAIN_KEYS,
  ITEM_KINDS,
  SENSITIVITIES,
} from '@app/shared/ontology';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// GET /api/graph/ontology — response DTO (#354, epic #344, ontology.md §17.4)
// =============================================================================
//
// A Zod MIRROR of `EffectiveSchemaPayload` from `@app/shared/ontology`, for the
// OpenAPI document only. The route returns `toEffectiveSchemaPayload(...)`
// verbatim — nothing here reshapes it.
//
// ⚠ A MIRROR NOBODY CHECKS IS A MIRROR THAT DRIFTS. Every object below is
// STRICT (unknown keys fail), and `graph-ontology.service.spec.ts` parses real
// `payloadFor()` output with `graphOntologyResponseSchema` — so a field added
// to, removed from or retyped in the shared payload fails a unit test here
// rather than publishing a document that lies. The enums are built FROM the
// shared package's own constant lists for the same reason.
// =============================================================================

const domainKeySchema = z
  .enum(DOMAIN_KEYS)
  .describe('A registered ontology domain key. `core` is always on.');

const sensitivitySchema = z
  .enum(SENSITIVITIES)
  .describe(
    'How private a value is (§5.6). `sensitive` values never leave this deployment for any purpose, under any setting.',
  );

const attributeOptionsSchema = z
  .strictObject({
    choices: z
      .array(
        z.strictObject({
          value: z.string().describe('The stored value.'),
          label: z.string().describe('Human label for a picker.'),
        }),
      )
      .optional()
      .describe('For `select`/`multi_select`: the permitted values, in display order.'),
    targetTypes: z
      .array(z.string())
      .optional()
      .describe('For `entity_ref`: the entity type keys a reference may point at.'),
  })
  .describe('Kind-specific options for an attribute.');

export const graphOntologyAttributeSchema = z
  .strictObject({
    key: z
      .string()
      .describe(
        'The attribute key inside `props`. Permanent. A user-defined attribute is `u_` plus ten lowercase alphanumerics.',
      ),
    label: z.string().describe('Human label for a form field.'),
    kind: z.enum(ATTRIBUTE_KINDS).describe('The value kind; drives the form control and validation.'),
    required: z.boolean().describe('Whether a value is required. Always false for a user attribute.'),
    list: z.boolean().describe('Whether the value is a list of `kind`. Always false for a user attribute.'),
    options: attributeOptionsSchema.nullable().describe('Kind-specific options, or null when the kind has none.'),
    extractable: z.boolean().describe('Whether extraction may propose a value for this attribute.'),
    description: z
      .string()
      .describe('Prompt copy. For a user attribute: its extraction hint, else its label.'),
    sensitivity: sensitivitySchema,
    source: z
      .enum(['builtin', 'mixin', 'user'])
      .describe(
        '`builtin` — declared on the type itself; `mixin` — added onto it by another enabled domain; `user` — one of your own attribute definitions.',
      ),
    domain: domainKeySchema.nullable().describe('The declaring domain; null for a user attribute.'),
    attributeDefId: z
      .string()
      .nullable()
      .describe('The `kg_attribute_defs` row id for a user attribute; null for a built-in or mixin one.'),
    deprecated: z
      .boolean()
      .describe('Retired: still readable on existing rows, never offered for new values.'),
    sortOrder: z.number().describe('Display order within the type.'),
  })
  .describe('One attribute of an entity type, or one prop of a relation type.');

const relationRepresentationSchema = z
  .discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('edge').describe('A `kg_relations` row.') }),
    z.strictObject({
      kind: z.literal('item_column').describe('A column on the `kg_items` row itself.'),
      column: z
        .enum(['subject_id', 'owner_person_id', 'counterparty_id', 'meeting_id'])
        .describe('Which `kg_items` column carries the relation.'),
    }),
    z.strictObject({
      kind: z.literal('speaker_link').describe('`kg_relations` with `from_speaker_id` (IDENTIFIED_AS).'),
    }),
    z.strictObject({ kind: z.literal('mention').describe('`kg_mentions`.') }),
    z.strictObject({ kind: z.literal('evidence').describe('`kg_evidence`.') }),
    z.strictObject({ kind: z.literal('supersedes').describe('`superseded_by_id` columns.') }),
  ])
  .describe('How instances of this relation type are physically stored.');

export const graphOntologyDomainSchema = z
  .strictObject({
    key: domainKeySchema,
    label: z.string().describe('Human label for the domain.'),
    enabled: z.boolean().describe('Whether this domain is part of your effective schema.'),
    alwaysOn: z.boolean().describe('Whether the domain cannot be switched off (`core`).'),
  })
  .describe('One registered domain, and whether it is in effect for you.');

export const graphOntologyEntityTypeSchema = z
  .strictObject({
    key: z.string().describe('PascalCase type key, e.g. `Person`. Permanent.'),
    domain: domainKeySchema,
    label: z.string().describe('Singular human label.'),
    pluralLabel: z.string().describe('Plural human label.'),
    description: z.string().describe('What this type is. Extraction-prompt copy.'),
    disambiguation: z
      .array(z.string())
      .describe('Rules telling this type apart from look-alikes. Extraction-prompt copy.'),
    storage: z
      .enum(['entity', 'item'])
      .describe('Whether instances are `kg_entities` rows or `kg_items` rows.'),
    itemKind: z
      .enum(ITEM_KINDS)
      .nullable()
      .describe('For an item type: its `kg_items.kind`; null for an entity type.'),
    statuses: z
      .array(z.string())
      .nullable()
      .describe('For an item type: its permitted statuses; null when the type has none.'),
    subjectTypes: z
      .array(z.string())
      .nullable()
      .describe(
        'For an item type: the entity types it may be about, pruned to those in your effective schema; null for an entity type.',
      ),
    subjectRequired: z.boolean().describe('Whether an item of this type must name a subject.'),
    sensitivityDefault: sensitivitySchema,
    alignment: z
      .string()
      .nullable()
      .describe('An external vocabulary term this type aligns with (e.g. `schema:Person`), or null.'),
    extractable: z.boolean().describe('Whether extraction may propose instances of this type.'),
    deprecated: z.boolean().describe('Retired: existing rows stay readable, no new ones are proposed.'),
    attributes: z
      .array(graphOntologyAttributeSchema)
      .describe('Built-in, then mixin, then your own attributes, in display order.'),
  })
  .describe('One entity (or item) type in your effective schema.');

export const graphOntologyRelationTypeSchema = z
  .strictObject({
    key: z.string().describe('UPPER_SNAKE relation key, e.g. `WORKS_AT`. Permanent.'),
    domain: domainKeySchema,
    label: z.string().describe('Human label.'),
    description: z.string().describe('What this relation means. Extraction-prompt copy.'),
    from: z
      .array(z.string())
      .describe('Permitted source types, pruned to those in your effective schema.'),
    to: z.array(z.string()).describe('Permitted target types, pruned to those in your effective schema.'),
    allowedPairs: z
      .array(
        // An exact-length array rather than `z.tuple`: a tuple publishes as
        // `prefixItems` with no `items`, which the OpenAPI lint rejects.
        z
          .array(z.string())
          .length(2)
          .describe('One permitted `[from, to]` pair: source type, then target type.'),
      )
      .nullable()
      .describe('When set, only these `[from, to]` combinations are valid; null means any from × to.'),
    temporal: z.boolean().describe('Whether instances carry a validity range.'),
    exclusive: z
      .enum(['soft', 'none'])
      .describe('`soft` — a new instance normally supersedes the current one in its scope.'),
    exclusiveScope: z
      .enum(['from', 'from_to'])
      .describe('What exclusivity is scoped to: the source alone, or the source and target pair.'),
    representation: relationRepresentationSchema,
    extractable: z.boolean().describe('Whether extraction may propose instances of this relation.'),
    alignment: z
      .string()
      .nullable()
      .describe('An external vocabulary term this relation aligns with, or null.'),
    deprecated: z.boolean().describe('Retired: existing rows stay readable, no new ones are proposed.'),
    props: z.array(graphOntologyAttributeSchema).describe('Props an instance of this relation may carry.'),
  })
  .describe('One relation type in your effective schema.');

export const graphOntologyResponseSchema = z
  .strictObject({
    version: z
      .string()
      .describe('The ontology version this schema was computed from (`ONTOLOGY_VERSION`).'),
    domains: z
      .array(graphOntologyDomainSchema)
      .describe('Every registered domain, in registry order, with whether it is in effect for you.'),
    entityTypes: z
      .array(graphOntologyEntityTypeSchema)
      .describe('Every entity and item type in your effective schema, in registry order.'),
    relationTypes: z
      .array(graphOntologyRelationTypeSchema)
      .describe('Every relation type whose endpoints survive in your effective schema.'),
  })
  .describe(
    'Your effective ontology: `core` plus your enabled domains, the mixins they add, and your own attribute definitions (deprecated ones included, flagged). Every graph form is generated from this.',
  );

export type GraphOntologyResponse = z.infer<typeof graphOntologyResponseSchema>;

export class GraphOntologyDto extends createZodDto(graphOntologyResponseSchema) {}
