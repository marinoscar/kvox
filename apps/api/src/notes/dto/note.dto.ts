import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import {
  MAX_CONTEXT_CHARS,
  MAX_NAME_CHARS,
  previewSourceSchema,
} from './note-template.dto';

// =============================================================================
// Note request/response shapes (issue #53, epic #45)
// =============================================================================
//
// Ten routes' worth of wire contract. Everything a client may send is described
// here and everything the controller returns is described here too, so the
// published OpenAPI document is generated from the SAME definitions the runtime
// validates against rather than from a parallel set of `@ApiProperty`
// decorators that can drift from them — the discipline `note-template.dto.ts`
// and `transcript.dto.ts` already state for themselves.
//
// -----------------------------------------------------------------------------
// ⚠ THE SOURCE UNION IS IMPORTED, NOT RE-DECLARED
// -----------------------------------------------------------------------------
//
// `previewSourceSchema` (in `note-template.dto.ts`) is already the exact
// three-member discriminated union `NoteSourceType` allows, written for the
// preview endpoint that landed first. A note's source is the same question with
// the same three answers, and a second copy of it here is a second thing to
// keep in step the day a fourth source kind exists. It is aliased rather than
// moved so no existing import has to change.
//
// -----------------------------------------------------------------------------
// ⚠ `baseVersion` IS REQUIRED WHENEVER `body` IS PRESENT, AND ONLY THEN
// -----------------------------------------------------------------------------
//
// Two tabs is the ordinary case, not an exotic one, and silently discarding the
// other tab's paragraph is the specific failure "the user controls the truth"
// exists to rule out. A TITLE change carries no such risk — a title is metadata
// about the note, not content of it (the same reasoning `PATCH
// /api/transcripts/:id` states for not versioning a rename) — so requiring a
// version for it would make renaming fail for a reason the user cannot see.
//
// The refinement below states the rule once; the service never has to guess.
// =============================================================================

/** Characters a note title may hold. The same ceiling a transcript title has. */
export const MAX_TITLE_CHARS = 200;

/**
 * Characters a note body may hold.
 *
 * A note is "a page or two of prose" (spec §4.5's own argument for full-body
 * version snapshots), and every save writes the whole body TWICE — once to
 * `notes.body` and once as an immutable `note_versions` row. 400 KB is roughly
 * sixty thousand words: far above anything this feature produces or a person
 * types, and far below the point where the version table's growth becomes the
 * problem §4.5 says it is not.
 */
export const MAX_BODY_CHARS = 400_000;

/** Characters a version `summary` may hold. One line in a history list. */
export const MAX_SUMMARY_CHARS = 200;

/** Notes per list page when the caller does not say. */
export const DEFAULT_PAGE_SIZE = 20;

/** Notes per list page, at most. */
export const MAX_PAGE_SIZE = 100;

/** Characters of `body` a list row carries as its excerpt. */
export const EXCERPT_CHARS = 280;

/**
 * The machine-readable `details.reason` values this controller's 409s carry.
 *
 * ⚠ THEY LIVE UNDER `details`, NOT AT THE TOP-LEVEL `code`. The global
 * `HttpExceptionFilter` derives `code` from the STATUS and deliberately ignores
 * any `code` an exception supplies — that is a published contract
 * (`common/dto/error.dto.ts` publishes `code` as a closed enum) and is asserted
 * by the filter's own spec. So a "code the UI can branch on" belongs exactly
 * where that filter says endpoint-specific machine-readable data belongs.
 */
export const NOTE_CONFLICT_REASONS = {
  /** The DEPLOYMENT has not enabled AI, or permits no model this build can run. */
  AI_NOT_CONFIGURED: 'ai_not_configured',
  /** The CALLER has saved no API key. A note is generated on their own account. */
  AI_KEY_MISSING: 'ai_key_missing',
  /** `baseVersion` did not equal `currentVersion`. `details.currentVersion` says what is. */
  STALE_BASE_VERSION: 'stale_base_version',
  /** A restore named the version that is already current. Nothing to do. */
  ALREADY_CURRENT: 'already_current',
  /** The note's template was deleted; a regeneration needs one named. */
  TEMPLATE_REQUIRED: 'template_required',
  /** The note is `generating`; a second writer is not available. */
  GENERATING: 'generating',
  /** Another note names this one as its source (`source_note_id` is Restrict). */
  DERIVED_NOTES_EXIST: 'derived_notes_exist',
  /** The note is already on its way out. */
  DELETING: 'deleting',
} as const;

export type NoteConflictReason =
  (typeof NOTE_CONFLICT_REASONS)[keyof typeof NOTE_CONFLICT_REASONS];

// -----------------------------------------------------------------------------
// The shared field vocabulary
// -----------------------------------------------------------------------------

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_TITLE_CHARS)
  .describe('The note\'s title. Metadata about the note, never versioned content of it.');

export const noteTitleSourceSchema = z
  .enum(['ai', 'user', 'template'])
  .describe(
    'Where this note\'s title came from. `ai` — a titling pass named it from the generated ' +
      'content; `user` — a person typed it, either on create or in a later rename; `template` — ' +
      'nobody named it, so it inherited the template\'s name. ' +
      '**`user` is never overwritten by an AI titling path**: a title a person chose is sticky, ' +
      'and the titling path checks this field before it renames anything.',
  );

export type NoteTitleSource = z.infer<typeof noteTitleSourceSchema>;

const bodySchema = z
  .string()
  .max(MAX_BODY_CHARS)
  .describe(
    'The note\'s full markdown body. Sending it appends a `note_versions` row and bumps ' +
      '`currentVersion`; **`baseVersion` is required alongside it**.',
  );

const summarySchema = z
  .string()
  .trim()
  .max(MAX_SUMMARY_CHARS)
  .describe('One line describing what this save changed, shown in the version history list.');

const contextTextSchema = z
  .string()
  .trim()
  .max(MAX_CONTEXT_CHARS)
  .describe(
    'Optional orienting note placed ahead of the source in the assembled prompt, exactly as a ' +
      'template preview places it.',
  );

/**
 * ⚠ THE SAME UNION A PREVIEW TAKES. See the header.
 */
export const noteSourceSchema = previewSourceSchema.describe(
  'What to generate from. You must be able to read it — a source you cannot read answers **404**.',
);

export type NoteSourceDto = z.infer<typeof noteSourceSchema>;

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * `POST /api/notes` — create the note AND queue its generation, in one call.
 *
 * ⚠ THERE IS NO `body` FIELD AND THERE NEVER MAY BE ONE. A note's first version
 * is `ai_generated` by construction (spec §4.5, and `authorId: null` means the
 * AI), so a client that could supply the initial body could mint a note whose
 * history claims the AI wrote text a user pasted in. Editing is `PATCH`'s job,
 * and it records an `edit` version with the author on it.
 */
export const createNoteSchema = z
  .object({
    title: titleSchema
      .optional()
      .describe(
        'Optional. Defaults to the template\'s name — a note is renameable the moment it exists, ' +
          'and asking for a title before anything has been generated is asking a user to name ' +
          'something they have not read yet.',
      ),
    templateId: z
      .string()
      .uuid()
      .describe('Which template to generate with. Your own, or a built-in.'),
    source: noteSourceSchema,
    contextText: contextTextSchema.optional(),
    model: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NAME_CHARS)
      .optional()
      .describe(
        'Override the model for this note alone. Must be one `GET /api/ai/config` lists; ' +
          "otherwise the template's own `model`, otherwise the deployment default.",
      ),
  })
  .strict();

export type CreateNoteDto = z.infer<typeof createNoteSchema>;

export class CreateNoteBodyDto extends createZodDto(createNoteSchema) {}

/**
 * `PATCH /api/notes/{id}` — the title, the body, or both.
 *
 * ⚠ `.refine`: `baseVersion` is required exactly when `body` is present. See
 * the file header for why a rename is deliberately exempt.
 */
export const updateNoteSchema = z
  .object({
    title: titleSchema.optional(),
    body: bodySchema.optional(),
    baseVersion: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(
        'The `currentVersion` you were editing. **Required with `body`.** A mismatch is a ' +
          '**409** whose `details.currentVersion` names what the note is actually at, so the ' +
          'client can show what it was about to overwrite.',
      ),
    summary: summarySchema.optional(),
    clientBatchId: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe(
        'Idempotency key. Re-sending a save with the same value returns the ORIGINAL result and ' +
          'creates no second version, so a retry after a dropped connection is always safe.',
      ),
  })
  .strict()
  .refine((value) => value.title !== undefined || value.body !== undefined, {
    message: 'Send at least one of `title` or `body`.',
  })
  .refine((value) => value.body === undefined || value.baseVersion !== undefined, {
    message: '`baseVersion` is required when `body` is present.',
    path: ['baseVersion'],
  });

export type UpdateNoteDto = z.infer<typeof updateNoteSchema>;

export class UpdateNoteBodyDto extends createZodDto(updateNoteSchema) {}

/**
 * `POST /api/notes/{id}/regenerate` — the only retry path (#49's `maxAttempts: 1`).
 *
 * Every field is optional and every omitted one falls back to what the note
 * already records, so the ordinary "try again" is an empty body.
 */
export const regenerateNoteSchema = z
  .object({
    templateId: z
      .string()
      .uuid()
      .optional()
      .describe('Regenerate with a DIFFERENT template. Defaults to the one the note already names.'),
    contextText: contextTextSchema
      .nullable()
      .optional()
      .describe(
        'Replace the note\'s context text for this and every later generation. `null` clears it; ' +
          'omitting it keeps what the note has.',
      ),
    model: z
      .string()
      .trim()
      .min(1)
      .max(MAX_NAME_CHARS)
      .optional()
      .describe('Override the model for this generation alone.'),
  })
  .strict();

export type RegenerateNoteDto = z.infer<typeof regenerateNoteSchema>;

export class RegenerateNoteBodyDto extends createZodDto(regenerateNoteSchema) {}

/**
 * `POST /api/notes/{id}/versions/{version}/restore`.
 *
 * ⚠ `baseVersion` MUST EQUAL `currentVersion` HERE. A restore carries no
 * per-entity expectations of its own (a note is one prose body — spec §4.5 —
 * so there is no `rev` to check), which means a stale view is asking to discard
 * edits the caller has never seen. The identical rule
 * `POST /api/transcripts/:id/versions/:v/restore` states for itself.
 */
export const restoreNoteVersionSchema = z
  .object({
    baseVersion: z
      .number()
      .int()
      .min(0)
      .describe('Must equal the note\'s `currentVersion`. A mismatch is a **409**.'),
    summary: summarySchema.optional(),
  })
  .strict();

export type RestoreNoteVersionDto = z.infer<typeof restoreNoteVersionSchema>;

export class RestoreNoteVersionBodyDto extends createZodDto(restoreNoteVersionSchema) {}

/**
 * `GET /api/notes` query string.
 *
 * ⚠ CURSOR, NEVER OFFSET. Generation and every save rewrite `updatedAt`, so an
 * offset page over a list that reorders itself while a user reads it skips rows
 * and repeats others — the same reasoning `transcriptListQuerySchema` states,
 * and `notes-pagination.db.spec.ts` is its executable form.
 */
export const noteListQuerySchema = z.object({
  status: z
    .enum(['draft', 'generating', 'ready', 'failed', 'deleting'])
    .optional()
    .describe('Filter to one lifecycle status.'),
  sourceType: z
    .enum(['transcript', 'note', 'document'])
    .optional()
    .describe('Filter by source KIND.'),
  sourceTranscriptId: z
    .string()
    .uuid()
    .optional()
    .describe('Every note generated from one transcript — what a transcript page asks for.'),
  sourceNoteId: z
    .string()
    .uuid()
    .optional()
    .describe('Every note generated from one other note.'),
  sourceObjectId: z
    .string()
    .uuid()
    .optional()
    .describe('Every note generated from one uploaded document.'),
  templateId: z.string().uuid().optional().describe('Every note produced by one template.'),
  q: z.string().trim().min(1).max(MAX_TITLE_CHARS).optional().describe('Case-insensitive title substring.'),
  cursor: z.string().optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .default(DEFAULT_PAGE_SIZE)
    .describe(`1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`),
});

export type NoteListQueryDto = z.infer<typeof noteListQuerySchema>;

export class NoteListQueryParamsDto extends createZodDto(noteListQuerySchema) {}

/** `GET /api/notes/{id}/versions` query string. */
export const noteVersionsQuerySchema = z.object({
  cursor: z.string().optional().describe('`nextCursor` from the previous page.'),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .optional()
    .default(DEFAULT_PAGE_SIZE)
    .describe(`1-${MAX_PAGE_SIZE} (default ${DEFAULT_PAGE_SIZE}).`),
});

export type NoteVersionsQueryDto = z.infer<typeof noteVersionsQuerySchema>;

export class NoteVersionsQueryParamsDto extends createZodDto(noteVersionsQuerySchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

const noteStatusSchema = z
  .enum(['draft', 'generating', 'ready', 'failed', 'deleting'])
  .describe(
    'The coarse, list-visible status (spec §1.1). `draft` means "never generated even once"; a ' +
      'note that already produced content is `generating` again, never back to `draft`.',
  );

/**
 * One note, as the detail route returns it.
 *
 * ⚠ `ownerId` IS NOT PUBLISHED. Owner-only access in this epic means the only
 * value it could hold for a caller is "you", and a field whose value is a
 * constant is a field a client can mistakenly branch on the day sharing lands.
 */
export const noteResponseSchema = z.object({
  id: z.string().describe('The note id.'),
  title: z.string().describe('The note\'s title.'),
  titleSource: noteTitleSourceSchema,
  body: z.string().describe('The live markdown body — by invariant, the version at `currentVersion`.'),
  status: noteStatusSchema,
  currentVersion: z
    .number()
    .describe('0 until the first generation commits, then the newest `note_versions.version`.'),
  provider: z.string().nullable().describe('Which AI provider produced the current body. `null` before the first generation.'),
  model: z.string().nullable().describe('Which model produced the current body.'),
  sourceType: z.enum(['transcript', 'note', 'document']).describe('Which kind of source this note was generated from.'),
  sourceTranscriptId: z.string().nullable().describe('Set when `sourceType` is `transcript`.'),
  sourceNoteId: z.string().nullable().describe('Set when `sourceType` is `note`.'),
  sourceObjectId: z.string().nullable().describe('Set when `sourceType` is `document`.'),
  templateId: z
    .string()
    .nullable()
    .describe('The template used. `null` once a deleted template\'s reference was nulled out.'),
  templateName: z
    .string()
    .nullable()
    .describe(
      'The template\'s name as it stands now, or `null` if the template is gone. The generation ' +
        'row keeps its own permanent `templateNameSnapshot` regardless.',
    ),
  /**
   * The SOURCE's name — issue #192, epic #162.
   *
   * Denormalised here beside `templateName`, and for the same reason: a client
   * that wants to render "from *Q3 planning*" rather than "from a transcript"
   * otherwise has to go and fetch it, which on a list is one request per
   * distinct source on the page. `apps/web/src/hooks/useNoteSourceNames.ts` was
   * that stand-in and said so in its own header; this field is what deletes it.
   *
   * ⚠ `null` MEANS "NO NAME AVAILABLE", NEVER "NO SOURCE". A deleted source, a
   * soft-deleted one, and — the case that matters — one the CALLER MAY NO
   * LONGER READ all answer the same way: a transcript shared with someone and
   * later unshared leaves the note pointing at it forever, and this field must
   * not become the leak that publishes its title. Clients render the category
   * noun ("a transcript") for `null`, which is what they already did before the
   * lookup landed.
   */
  sourceName: z
    .string()
    .nullable()
    .describe(
      'The name of the transcript, note or document this note was generated from, or `null` ' +
        'when it no longer exists or the caller may no longer read it. Never a bare id.',
    ),
  contextText: z.string().nullable().describe('The free-text context carried into every generation.'),
  currentGenerationId: z
    .string()
    .nullable()
    .describe('The generation to watch (`GET /api/notes/{id}/stream`). Never cleared once set.'),
  failureReason: z.string().nullable().describe('Why the most recent generation failed, when it did.'),
  // ⚠ `z.string()`, NOT `z.date()`: these schemas also generate the published
  // OpenAPI document, and a `z.date()` is not expressible as JSON Schema.
  createdAt: z.string().describe('When the note was created (ISO 8601).'),
  updatedAt: z.string().describe('When the note last changed (ISO 8601).'),
});

export type NoteResponse = z.infer<typeof noteResponseSchema>;

export class NoteDto extends createZodDto(noteResponseSchema) {}

/** One row of `GET /api/notes`. The body is an excerpt, never the whole thing. */
export const noteListItemSchema = noteResponseSchema
  .omit({ body: true, contextText: true })
  .extend({
    excerpt: z
      .string()
      .describe(
        `The first ${EXCERPT_CHARS} characters of the body. A list renders a snippet; fetch the ` +
          'note itself for the rest.',
      ),
  });

export type NoteListItem = z.infer<typeof noteListItemSchema>;

export const noteListResponseSchema = z.object({
  items: z.array(noteListItemSchema).describe('One page of notes, `updatedAt` descending.'),
  /**
   * How many rows match the current filters, ignoring paging.
   *
   * THE FILTERS, NOT THE TABLE, and not "how many are left". It is counted over
   * the same predicate the page is read with, minus the keyset cursor clause,
   * so it is IDENTICAL on page one and on every `loadMore` for an unchanged
   * filter set — a client can render "42 notes" once and not watch the
   * number fall as the user pages.
   *
   * Counted rather than estimated: the predicate is already scoped to one
   * caller and covered by `(owner_id, updated_at desc)`, so this is an index
   * scan over that user's rows, and an approximation would be a worse answer
   * for no gain.
   */
  total: z
    .number()
    .int()
    .describe(
      'How many notes match the current filters, ignoring paging. Identical on every page of one ' +
        'filter set, so a client can render a result count that does not change as it pages.',
    ),

  nextCursor: z
    .string()
    .nullable()
    .describe('Pass as `cursor` for the next page. `null` means this was the last one.'),
});

export class NoteListDto extends createZodDto(noteListResponseSchema) {}

/** `POST /api/notes` — the note, plus what was queued for it. */
export const createNoteResponseSchema = z.object({
  note: noteResponseSchema,
  generationId: z
    .string()
    .describe('The `note_generations` row this note streams into. Attach with `GET /api/notes/{id}/stream`.'),
  jobId: z.string().describe('The `note.generate` job queued for it.'),
  providerId: z.string().describe('The AI provider this generation was submitted to.'),
  model: z.string().describe('The model it will use. ⚠ Billed to **your** account, not the deployment\'s.'),
});

export class CreateNoteResultDto extends createZodDto(createNoteResponseSchema) {}

/** `POST /api/notes/{id}/regenerate`. */
export const regenerateNoteResponseSchema = createNoteResponseSchema;

export class RegenerateNoteResultDto extends createZodDto(regenerateNoteResponseSchema) {}

/** `GET /api/notes/summary` — the home page's one request. */
export const noteSummaryResponseSchema = z.object({
  inProgress: z
    .array(noteListItemSchema)
    .describe('Notes currently `draft` or `generating` — what the home page shows a spinner for.'),
  recent: z.array(noteListItemSchema).describe('The eight most recently touched notes.'),
  failed: z.array(noteListItemSchema).describe('The eight most recent notes whose generation failed.'),
  counts: z.object({
    total: z.number().describe('Every note you own that is not being deleted.'),
    ready: z.number(),
    inProgress: z.number(),
    failed: z.number(),
  }),
});

export class NoteSummaryDto extends createZodDto(noteSummaryResponseSchema) {}

/**
 * One entry in the version history.
 *
 * ⚠ `author: null` MEANS THE AI, not a missing value — the identical convention
 * `transcript_versions.author_id` established, carried across deliberately.
 */
export const noteVersionSchema = z.object({
  version: z.number().describe('The version number. `1` is always the AI\'s own first output.'),
  kind: z
    .enum(['ai_generated', 'edit', 'restore'])
    .describe('`ai_generated` came from a generation; `edit` from a `PATCH`; `restore` from a restore.'),
  summary: z.string().nullable().describe('One line describing what changed, when one was recorded.'),
  author: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable()
    .describe('Who saved it. **`null` means the AI** — a statement, not a missing value.'),
  generationId: z.string().nullable().describe('Which generation produced it, for `ai_generated` rows.'),
  restoredFromVersion: z.number().nullable().describe('Which version this one restored, for `restore` rows.'),
  createdAt: z.string().describe('When it was recorded (ISO 8601).'),
});

export const noteVersionListResponseSchema = z.object({
  currentVersion: z.number().describe('The note\'s current version, for comparison against the list.'),
  items: z.array(noteVersionSchema).describe('One page of versions, newest first.'),
  nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page.'),
});

export class NoteVersionsDto extends createZodDto(noteVersionListResponseSchema) {}

/** `GET /api/notes/{id}/versions/{version}` — one materialized version. */
export const noteVersionDetailResponseSchema = noteVersionSchema.extend({
  noteId: z.string().describe('The note this version belongs to.'),
  body: z
    .string()
    .describe(
      'The full markdown AS IT WAS at this version. A **full snapshot**, not an operation log ' +
        'replay: a note is a page or two of prose, so storing the whole body per save costs ' +
        'kilobytes and needs no reducer to read back (spec §4.5).',
    ),
  isCurrent: z.boolean().describe('Whether this version is the note\'s current one.'),
});

export class NoteVersionDetailDto extends createZodDto(noteVersionDetailResponseSchema) {}

/**
 * The 409 body a stale `baseVersion` produces.
 *
 * Published as a real schema so the contract "a conflict NAMES the current
 * version" is in the document rather than only in prose — a client that cannot
 * see what it is about to overwrite cannot offer the user the choice this
 * status code exists to give them.
 */
export const noteConflictSchema = z.object({
  statusCode: z.literal(409),
  code: z.literal('CONFLICT'),
  message: z.string(),
  details: z.object({
    reason: z
      .string()
      .describe(
        'A stable machine-readable reason: `stale_base_version`, `already_current`, ' +
          '`generating`, `deleting`, `template_required`, `ai_not_configured`, ' +
          '`ai_key_missing` or `derived_notes_exist`.',
      ),
    currentVersion: z
      .number()
      .optional()
      .describe('What the note is actually at, for `stale_base_version`.'),
  }),
});

export class NoteConflictDto extends createZodDto(noteConflictSchema) {}
