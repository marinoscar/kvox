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

import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { USER_DATA_SCOPES } from '../job-types';

// -----------------------------------------------------------------------------
// GET /api/user-data/summary
// -----------------------------------------------------------------------------

/** One category's row count and the bytes behind it. */
export const userDataCategorySchema = z.object({
  count: z
    .number()
    .int()
    .describe('How many rows of this category the caller owns, soft-deleted ones excluded.'),
  bytes: z
    .string()
    .describe(
      'Total size in bytes of the storage objects this category owns, as a **decimal ' +
        'string**. A string rather than a number because a large media library exceeds ' +
        "JavaScript's safe integer range and a JSON number would round it silently.",
    ),
});

export class UserDataCategoryDto extends createZodDto(userDataCategorySchema) {}

/**
 * A category with no bytes of its own.
 *
 * Note templates are rows of text; there is no storage object behind one, and
 * reporting `bytes: "0"` would invite a client to render a size that is not
 * merely zero but meaningless.
 */
export const userDataCountOnlySchema = z.object({
  count: z.number().int().describe('How many rows of this category the caller owns.'),
});

export class UserDataCountOnlyDto extends createZodDto(userDataCountOnlySchema) {}

/** What `scope: 'everything'` additionally destroys. */
export const userDataCredentialsSchema = z.object({
  aiKeys: z
    .number()
    .int()
    .describe("How many AI provider keys the caller has stored, one per provider."),
  accessTokens: z
    .number()
    .int()
    .describe('How many personal access tokens the caller holds that are not already revoked.'),
});

export class UserDataCredentialsDto extends createZodDto(userDataCredentialsSchema) {}

/**
 * The caller's knowledge graph (#357, epic #344) — removed by `content` and
 * `everything` through a `kg.purge` job. Row counts only: a graph row has no
 * storage object behind it, so there are no bytes to report.
 */
export const userDataGraphSchema = z.object({
  entities: z
    .number()
    .int()
    .describe(
      "How many entities (people, organizations, projects, meetings) the caller's graph " +
        'holds. Merge tombstones are excluded — a merged entity is the same thing as the ' +
        'one it was merged into.',
    ),
  items: z
    .number()
    .int()
    .describe(
      "How many facts (commitments, decisions, claims, person facts) the caller's graph holds.",
    ),
});

export class UserDataGraphDto extends createZodDto(userDataGraphSchema) {}

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
  scope: z.enum(USER_DATA_SCOPES).describe('What that deletion is removing.'),
  status: z
    .string()
    .describe('The job status — `pending` while it waits for a worker, `running` once claimed.'),
  requestedAt: z.string().describe('When it was queued (ISO 8601).'),
});

export class ActiveUserDataDeletionDto extends createZodDto(activeUserDataDeletionSchema) {}

export const userDataSummarySchema = z.object({
  transcripts: userDataCategorySchema.describe(
    "The caller's transcripts and every storage object they own — source audio, the " +
      'playback rendition, the raw provider result, version snapshots and rendered exports.',
  ),
  notes: userDataCategorySchema.describe(
    "The caller's notes, their rendered exports and any uploaded source document.",
  ),
  files: userDataCategorySchema.describe(
    'Plain uploads: storage objects the caller uploaded that no module manages. A ' +
      "transcript's audio is NOT counted here — it belongs to the transcript.",
  ),
  noteTemplates: userDataCountOnlySchema.describe(
    "The caller's own custom note templates. Removed by `content` and `everything` only — " +
      'the narrow `notes` scope leaves them alone, because a template is reusable ' +
      'configuration with its own settings page rather than note content. Built-ins are ' +
      'excluded from this count entirely: they belong to the deployment, are readable by ' +
      'everyone, and no user can delete one.',
  ),
  credentials: userDataCredentialsSchema.describe(
    'What `scope: "everything"` additionally destroys.',
  ),
  graph: userDataGraphSchema.describe(
    "The caller's knowledge graph. Removed by `content` and `everything` only — no narrow " +
      'scope touches it. Your recordings and notes are what the graph was derived from; ' +
      'deleting the graph never changes them.',
  ),
  askConversations: userDataCountOnlySchema.describe(
    "The caller's saved Ask conversations (and every message in them). Removed by `content` " +
      'and `everything` only — no narrow scope touches them.',
  ),
  activeDeletion: activeUserDataDeletionSchema
    .nullable()
    .describe('The deletion already queued or running for this caller, or `null`.'),
});

export type UserDataSummary = z.infer<typeof userDataSummarySchema>;

export class UserDataSummaryDto extends createZodDto(userDataSummarySchema) {}

// -----------------------------------------------------------------------------
// POST /api/user-data/deletions
// -----------------------------------------------------------------------------

export const createUserDataDeletionSchema = z.object({
  scope: z
    .enum(USER_DATA_SCOPES)
    .describe(
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
        '`EVERYTHING`. Deliberately scope-specific: a word typed into one dialog can ' +
        'never authorise a different scope. Anything else is a 400.',
    ),
});

export type CreateUserDataDeletionDto = z.infer<typeof createUserDataDeletionSchema>;

export class CreateUserDataDeletionBodyDto extends createZodDto(createUserDataDeletionSchema) {}

/** What `POST /api/user-data/deletions` answers with. */
export const userDataDeletionSchema = z.object({
  id: z.string().describe('The `user.data.purge` job id. Watch it in the admin job list.'),
  scope: z.enum(USER_DATA_SCOPES).describe('The scope this deletion was queued for.'),
  status: z.string().describe('`pending` — the job has been queued, not yet claimed.'),
  requestedAt: z.string().describe('When it was queued (ISO 8601).'),
});

export type UserDataDeletionResponse = z.infer<typeof userDataDeletionSchema>;

export class UserDataDeletionDto extends createZodDto(userDataDeletionSchema) {}
