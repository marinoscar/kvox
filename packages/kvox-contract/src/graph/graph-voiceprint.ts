import { z } from 'zod';

// =============================================================================
// Speaker voiceprints and name suggestions (#826, epic #820)
// =============================================================================
//
// Wire shapes of `/api/graph/speaker-suggestions` and `/api/graph/voiceprints`.
// BIOMETRIC: no response here ever carries a vector or audio; only counts,
// durations, ids and the scores of a suggestion.
// =============================================================================

/**
 * Zod schema for `GET /api/graph/speaker-suggestions` query.
 *
 * @stability experimental
 */
export const speakerSuggestionsQuerySchema = z.object({
  transcriptId: z.uuid(),
});

/**
 * The parsed shape of {@link speakerSuggestionsQuerySchema}.
 *
 * @stability experimental
 */
export type SpeakerSuggestionsQuery = z.infer<typeof speakerSuggestionsQuerySchema>;

/**
 * Zod schema for one pending speaker-name suggestion.
 *
 * @stability experimental
 */
export const speakerSuggestionSchema = z.object({
  id: z.uuid(),
  speakerId: z.uuid(),
  entityId: z.uuid().describe('The suggested Person.'),
  entityName: z.string().describe("The Person's canonical name."),
  score: z.number().describe('Cosine similarity of the voices, higher is closer.'),
  margin: z.number().nullable().describe('The lead over the runner-up.'),
  createdAt: z.iso.datetime(),
});

/**
 * The parsed shape of {@link speakerSuggestionSchema}.
 *
 * @stability experimental
 */
export type SpeakerSuggestion = z.infer<typeof speakerSuggestionSchema>;

/**
 * Zod schema for the `GET /api/graph/speaker-suggestions` response.
 *
 * @stability experimental
 */
export const speakerSuggestionsResponseSchema = z.array(speakerSuggestionSchema);

/**
 * The parsed shape of {@link speakerSuggestionsResponseSchema}.
 *
 * @stability experimental
 */
export type SpeakerSuggestionsResponse = z.infer<typeof speakerSuggestionsResponseSchema>;

/**
 * Zod schema for the decision routes' response (`accept` and `dismiss`).
 *
 * @stability experimental
 */
export const speakerSuggestionDecisionSchema = z.object({
  id: z.uuid(),
  status: z.enum(['accepted', 'dismissed']),
  decidedAt: z.iso.datetime(),
});

/**
 * The parsed shape of {@link speakerSuggestionDecisionSchema}.
 *
 * @stability experimental
 */
export type SpeakerSuggestionDecision = z.infer<typeof speakerSuggestionDecisionSchema>;

/**
 * Zod schema for `GET /api/graph/entities/:id/voiceprint`.
 *
 * @stability experimental
 */
export const personVoiceprintSchema = z.object({
  enrolled: z.boolean(),
  samples: z.number().int().nonnegative(),
  speechMs: z.number().int().nonnegative().describe('Total speech the samples were learned from.'),
  lastUpdatedAt: z.iso.datetime().nullable(),
  modelId: z.string().nullable(),
});

/**
 * The parsed shape of {@link personVoiceprintSchema}.
 *
 * @stability experimental
 */
export type PersonVoiceprint = z.infer<typeof personVoiceprintSchema>;

/**
 * Zod schema for `DELETE /api/graph/voiceprints`.
 *
 * @stability experimental
 */
export const deleteAllVoiceprintsResponseSchema = z.object({
  deletedSamples: z.number().int().nonnegative(),
  deletedSuggestions: z.number().int().nonnegative(),
});

/**
 * The parsed shape of {@link deleteAllVoiceprintsResponseSchema}.
 *
 * @stability experimental
 */
export type DeleteAllVoiceprintsResponse = z.infer<typeof deleteAllVoiceprintsResponseSchema>;

/**
 * Zod schema for `GET /api/graph/voiceprints/summary`.
 *
 * @stability experimental
 */
export const voiceprintsSummarySchema = z.object({
  enabled: z.boolean(),
  consentAt: z.iso.datetime().nullable(),
  people: z.number().int().nonnegative().describe('People with at least one voiceprint.'),
  samples: z.number().int().nonnegative(),
});

/**
 * The parsed shape of {@link voiceprintsSummarySchema}.
 *
 * @stability experimental
 */
export type VoiceprintsSummary = z.infer<typeof voiceprintsSummarySchema>;
