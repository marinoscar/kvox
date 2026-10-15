// =============================================================================
// Danger Zone request and response shapes (issue #80)
// =============================================================================
//
// ZOD, NOT class-validator, matching `notes/dto/*` and `transcripts/dto/*`: the
// global `ZodValidationPipe` is what actually runs, and a `class-validator`
// decorator on a body it never inspects is a validation that LOOKS present in
// the source and is inert at runtime. On a module whose entire purpose is
// irreversible deletion, "looks validated" is the worst available property.
//
// -----------------------------------------------------------------------------
// ⚠ WHY `bytes` IS A DECIMAL STRING AND NOT A NUMBER
// -----------------------------------------------------------------------------
//
// `storage_objects.size` is `BigInt` because this application accepts multi-GB
// recordings (schema, issue #21), and a user with a few hundred hours of audio
// is genuinely capable of exceeding `Number.MAX_SAFE_INTEGER` in a total. A
// JSON number would round that silently — JSON has no integers, only doubles —
// so the number shown in a confirmation dialog would drift from the number of
// bytes about to be destroyed, with nothing anywhere reporting it.
//
// The same decision, for the same reason, as the database backup's `bytes`
// crossing the node boundary as a decimal string (`docs/specs/database-backup
// .md` §16). REJECTED: sending megabytes as a float, which makes the rounding
// invisible instead of absent, and leaves the client unable to render an exact
// figure even when one would fit.
//
// `count` stays a plain number: a row count that overflows a double is not a
// state this application can reach.
//
// -----------------------------------------------------------------------------
// `z.string()` FOR TIMESTAMPS, NEVER `z.date()`
// -----------------------------------------------------------------------------
//
// These schemas also generate the published OpenAPI document, and a `z.date()`
// has no JSON Schema expression. The services below call `.toISOString()`, the
// same convention `note.dto.ts` states at its own timestamp fields.
// =============================================================================
//
// -----------------------------------------------------------------------------
// COMPOSED FROM THE CATEGORY AND SCOPE REGISTRIES (issue #460)
// -----------------------------------------------------------------------------
//
// The summary schema and the scope enum used to name every domain by hand. They
// are now built, at import time, from `user-data.registries.ts`: each category's
// `summary.schema` is one property (in category order, which IS the wire key
// order), and the scope enum is the registered scope ids. `kvox.manifest.ts`
// runs before any DTO module, so the registries are filled by now; an empty one
// throws rather than publishing a schema that rejects every request. The
// reusable branches (`userDataCategorySchema`, ...) live in
// `user-data-summary-parts.ts`, which reads no registry, so a domain's
// `*.user-data.ts` can import them while the manifest is still evaluating.
// =============================================================================

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { USER_DATA_SCOPES } from '../job-types';
import { USER_DATA_ACTIVE_DELETION_KEY, userDataCategories } from '../user-data.registries';

export * from './user-data-summary-parts';

/** `z.enum` over the registered scope ids, in the order the UI renders them. */
const scopeEnum = z.enum(USER_DATA_SCOPES as unknown as [string, ...string[]]);

// -----------------------------------------------------------------------------
// GET /api/user-data/summary
// -----------------------------------------------------------------------------

/**
 * The deletion already in flight for this caller, if any.
 *
 * ⚠ ITS PRESENCE IS WHY `POST /api/user-data/deletions` WOULD 409. A client
 * showing the Danger Zone reads this field to disable its own buttons — but
 * that is a courtesy, not the enforcement: the enforcement is the queue's
 * partial unique index, and a client that ignores this field gets a 409 rather
 * than a second deletion.
 */
export const activeUserDataDeletionSchema = z.object({
  id: z.string().describe('The `user.data.purge` job id.'),
  scope: scopeEnum.describe('What that deletion is removing.'),
  status: z
    .string()
    .describe('The job status — `pending` while it waits for a worker, `running` once claimed.'),
  requestedAt: z.string().describe('When it was queued (ISO 8601).'),
});

export class ActiveUserDataDeletionDto extends createZodDto(activeUserDataDeletionSchema) {}

/**
 * The summary response: one property per registered category that declares a
 * `summary`, in category order, then `activeDeletion`.
 */
function composeSummarySchema() {
  const shape: Record<string, z.ZodType> = {};

  for (const category of userDataCategories()) {
    if (category.summary) shape[category.summary.key] = category.summary.schema;
  }

  if (Object.keys(shape).length === 0) {
    throw new Error(
      'User-data categories are not registered: import apps/api/src/kvox.manifest before the ' +
        'user-data DTOs.',
    );
  }

  shape[USER_DATA_ACTIVE_DELETION_KEY] = activeUserDataDeletionSchema
    .nullable()
    .describe('The deletion already queued or running for this caller, or `null`.');

  return z.object(shape);
}

export const userDataSummarySchema = composeSummarySchema();

/**
 * The summary as the service returns it. Per-category branches are declared by
 * their domains, so this names only the one key the base owns.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type UserDataSummary = Record<string, any> & {
  activeDeletion: z.infer<typeof activeUserDataDeletionSchema> | null;
};

export class UserDataSummaryDto extends createZodDto(userDataSummarySchema) {}

// -----------------------------------------------------------------------------
// POST /api/user-data/deletions
// -----------------------------------------------------------------------------

export const createUserDataDeletionSchema = z.object({
  scope: scopeEnum.describe(
    'What to delete. Each narrow scope removes exactly the category it names — `notes` ' +
      'does **not** take your note templates with it. `content` is every recording, note, ' +
      'uploaded file, your own custom note templates, your knowledge graph **and** your Ask ' +
      'conversations; ' +
      '`everything` is that plus your AI provider keys and your personal access tokens.',
  ),
  confirmation: z
    .string()
    .describe(
      'The **scope, uppercased** — `TRANSCRIPTS`, `NOTES`, `FILES`, `CONTENT` or ' +
        '`EVERYTHING`. Deliberately scope-specific: a word typed for one dialog can ' +
        'never authorise a different scope. Anything else is a 400.',
    ),
});

export type CreateUserDataDeletionDto = z.infer<typeof createUserDataDeletionSchema>;

export class CreateUserDataDeletionBodyDto extends createZodDto(createUserDataDeletionSchema) {}

/** What `POST /api/user-data/deletions` answers with. */
export const userDataDeletionSchema = z.object({
  id: z.string().describe('The `user.data.purge` job id. Watch it in the admin job list.'),
  scope: scopeEnum.describe('The scope this deletion was queued for.'),
  status: z.string().describe('`pending` — the job has been queued, not yet claimed.'),
  requestedAt: z.string().describe('When it was queued (ISO 8601).'),
});

export type UserDataDeletionResponse = z.infer<typeof userDataDeletionSchema>;

export class UserDataDeletionDto extends createZodDto(userDataDeletionSchema) {}
