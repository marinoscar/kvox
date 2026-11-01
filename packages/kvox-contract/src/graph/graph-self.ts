import { z } from 'zod';

// =============================================================================
// The account owner's own node (#778)
// =============================================================================
//
// `GET /api/graph/self`: who the user chose as themselves in their graph
// (`preferences.self.entityId`, resolved: a merged-away Person is followed to its
// target) and, while none is chosen, a few Persons whose label or alias matches the
// user's profile name. A suggestion is only ever offered; nothing is written until the
// user picks.
// =============================================================================

/**
 * Zod schema for the Person shown as the account owner.
 *
 * @stability experimental
 */
export const graphSelfEntitySchema = z.object({
  id: z.uuid(),
  label: z.string(),
  aliases: z.array(z.string()).describe('The alias strings other than the label.'),
});

/**
 * The parsed shape of {@link graphSelfEntitySchema}.
 *
 * @stability experimental
 */
export type GraphSelfEntity = z.infer<typeof graphSelfEntitySchema>;

/**
 * Zod schema for the `GET /api/graph/self` response.
 *
 * @stability experimental
 */
export const graphSelfResponseSchema = z.object({
  self: graphSelfEntitySchema
    .nullable()
    .describe('The chosen Person, resolved; null when none is chosen or the stored one is no longer a live Person of yours.'),
  suggestions: z
    .array(graphSelfEntitySchema)
    .max(5)
    .describe('Persons matching your profile name. Empty while `self` is set. A suggestion, never applied by itself.'),
  displayName: z.string().nullable().describe('The profile name the suggestions were matched against.'),
});

/**
 * The parsed shape of {@link graphSelfResponseSchema}.
 *
 * @stability experimental
 */
export type GraphSelfResponse = z.infer<typeof graphSelfResponseSchema>;
