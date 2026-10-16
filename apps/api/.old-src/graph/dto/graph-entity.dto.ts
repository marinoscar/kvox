import { KG_ALIAS_SOURCES_FOR_DTO, KG_REVIEW_STATUSES_FOR_DTO } from './graph-enums';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Graph entity DTOs (#355, epic #344; docs/specs/ontology.md §8)
// =============================================================================
//
// `PATCH /api/graph/entities/:id` — the manual entity edit, §8's second named
// exception to "nothing enters the graph except through a reviewed proposal".
// `graphEntitySchema` is the entity projection; #370 extends it with counts.
// =============================================================================

export const patchEntitySchema = z
  .object({
    label: z.string().trim().min(1).max(200).optional().describe('The new display name. The old one is kept as an alias.'),
    props: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('A merge: `key → value` sets that key, `key → null` clears it. Keys not sent are unchanged. The merged result must validate against your effective schema.'),
    addAliases: z
      .array(z.string().trim().min(1).max(200))
      .max(20)
      .optional()
      .describe('Other names for this entity. One that normalizes to an existing alias is ignored, not an error.'),
    removeAliasIds: z.array(z.uuid()).max(50).optional().describe('Alias ids to remove.'),
    type: z
      .never({ error: 'Change a type through a proposal.' })
      .optional()
      .describe('Not accepted: a type change is a proposal item, never a manual edit.'),
  })
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update.');

export type PatchEntityDto = z.infer<typeof patchEntitySchema>;
export class PatchEntityBodyDto extends createZodDto(patchEntitySchema) {}

export const graphEntityAliasSchema = z.object({
  id: z.uuid(),
  alias: z.string().describe('The name as written.'),
  normalized: z.string().describe('The comparison form every exact-match lookup reads (§7).'),
  source: z.enum(KG_ALIAS_SOURCES_FOR_DTO).describe('Where this alias came from.'),
  createdAt: z.string().describe('ISO 8601.'),
});

export const graphEntitySchema = z
  .object({
    id: z.uuid(),
    type: z.string().describe('An entity type key of your effective schema.'),
    label: z.string(),
    props: z.record(z.string(), z.unknown()).describe('Attribute values, keyed by attribute key.'),
    reviewStatus: z.enum(KG_REVIEW_STATUSES_FOR_DTO),
    mergedIntoId: z.uuid().nullable(),
    occurredAt: z.string().nullable().describe('ISO 8601; set for event-like entities (a Meeting).'),
    ontologyVersion: z.string(),
    aliases: z.array(graphEntityAliasSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .describe('One entity of your knowledge graph.');

export type GraphEntityResponse = z.infer<typeof graphEntitySchema>;
export class GraphEntityDto extends createZodDto(graphEntitySchema) {}
