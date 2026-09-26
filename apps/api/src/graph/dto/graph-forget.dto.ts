import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// "Forget this person" DTOs (#357, epic #344; docs/specs/ontology.md §15)
// =============================================================================
//
// `POST /api/graph/entities/:id/forget`. The body is a typed confirmation, the
// Danger Zone convention: a word the caller must type, so a stray click (or a
// replayed request with an empty body) can never delete anything.
// =============================================================================

/** The one word that authorises forgetting a person. */
export const FORGET_CONFIRMATION = 'FORGET';

/** The 400 message for a missing or wrong confirmation. */
export const FORGET_CONFIRMATION_MESSAGE = `Type ${FORGET_CONFIRMATION} to confirm.`;

/** The 400 message for an entity that is not a Person. */
export const FORGET_NOT_PERSON_MESSAGE =
  'Only a person can be forgotten; delete other entities by editing or reverting the proposal that created them.';

export const forgetEntitySchema = z.object({
  confirmation: z
    .literal(FORGET_CONFIRMATION, { error: FORGET_CONFIRMATION_MESSAGE })
    .describe('Exactly `FORGET`. Anything else, or nothing, is a 400.'),
});

export type ForgetEntityDto = z.infer<typeof forgetEntitySchema>;
export class ForgetEntityBodyDto extends createZodDto(forgetEntitySchema) {}

export const forgetEntityResponseSchema = z
  .object({
    jobId: z.string().describe('The `kg.purge` job doing the deletion.'),
    entityId: z.uuid().describe('The person being forgotten.'),
    status: z
      .enum(['pending', 'running'])
      .describe(
        '`pending` while it waits for a worker, `running` once claimed. Asking again while ' +
          'one is pending or running returns that same job.',
      ),
  })
  .describe('The queued deletion. The person stays visible until the job completes.');

export type ForgetEntityResponse = z.infer<typeof forgetEntityResponseSchema>;
export class ForgetEntityResponseDto extends createZodDto(forgetEntityResponseSchema) {}
