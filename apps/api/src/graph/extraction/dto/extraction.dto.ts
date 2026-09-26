import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Graph extraction DTOs (#363, epic #346; docs/specs/ontology.md §6, §12, §19, §20)
// =============================================================================
//
// `POST /api/graph/notes/:noteId/extract` and `GET /api/graph/extract/estimate`.
// =============================================================================

export const userGuidanceSchema = z
  .object({
    pinnedEntityIds: z
      .array(z.guid())
      .max(50)
      .default([])
      .describe('Entities of yours to focus on. Each must be a live entity you own (400 `details.invalidPinnedIds` otherwise).'),
    entityTypes: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Ontology type keys to propose (e.g. `Person`, `Commitment`). Absent = every type in your effective ontology. An unknown key is a 400 naming it in `details.unknownTypes`.'),
    relationTypes: z
      .array(z.string())
      .max(50)
      .optional()
      .describe('Relation type keys to propose (e.g. `WORKS_FOR`). Absent = every relation type in your effective ontology.'),
    instructions: z
      .string()
      .trim()
      .max(2000)
      .default('')
      .describe('Free-text preferences for this run. They narrow or focus the proposal; they never override the extraction rules.'),
  })
  .strict();

export type UserGuidance = z.infer<typeof userGuidanceSchema>;

export const requestExtractionSchema = z
  .object({
    model: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe('Run on this model instead of the `graph.extract` task model. Must be one this deployment permits (400 otherwise) and support structured output (409 `model_lacks_capability`).'),
    userGuidance: userGuidanceSchema.optional(),
  })
  .strict();

export type RequestExtractionDto = z.infer<typeof requestExtractionSchema>;
export class RequestExtractionBodyDto extends createZodDto(requestExtractionSchema) {}

export const extractionEstimateSchema = z
  .object({
    providerId: z.string().describe('The AI provider the run would use.'),
    model: z.string().describe('The model the run would use.'),
    inputTokens: z.number().int().describe('Tokens in the exact prompt the run would send (reviewer guidance excluded from an estimate — at most 2,000 characters).'),
    maxOutputTokens: z.number().int().describe('The completion ceiling the run would use.'),
    availableInputTokens: z.number().int().describe('Tokens this model and deployment allow for input.'),
    fits: z.boolean().describe('Whether `inputTokens` fits `availableInputTokens`.'),
    requests: z.number().int().describe('Provider calls the run makes: one extraction call (resolution adds its own later).'),
    keyConfigured: z.boolean().describe('Whether you have saved an API key for this provider. Counting needs none.'),
  })
  .describe('What an extraction of this note would cost, without running it.');

export type ExtractionEstimate = z.infer<typeof extractionEstimateSchema>;
export class ExtractionEstimateDto extends createZodDto(extractionEstimateSchema) {}

export const requestExtractionResponseSchema = z.object({
  proposal: z.object({
    id: z.guid(),
    noteId: z.guid(),
    noteVersion: z.number().int(),
    status: z.literal('extracting'),
    model: z.string(),
    providerId: z.string(),
    createdAt: z.string(),
  }),
  estimate: extractionEstimateSchema,
});

export type RequestExtractionResponse = z.infer<typeof requestExtractionResponseSchema>;
export class RequestExtractionResponseDto extends createZodDto(requestExtractionResponseSchema) {}

export const extractionEstimateQuerySchema = z
  .object({
    noteId: z.guid(),
    model: z.string().min(1).max(200).optional(),
  })
  .strict();

export type ExtractionEstimateQuery = z.infer<typeof extractionEstimateQuerySchema>;
