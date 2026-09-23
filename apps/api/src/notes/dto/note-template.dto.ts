import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

// =============================================================================
// Note template request/response shapes (issue #50, epic #45)
// =============================================================================
//
// Seven endpoints, four request schemas and five response shapes. Everything a
// client may send is described here; everything the controller returns is
// described here too, so the OpenAPI document is generated from the same
// definitions the runtime validates against rather than from a parallel set of
// `@ApiProperty` decorators that can drift from them.
//
// -----------------------------------------------------------------------------
// ⚠ `instructions` HAS NO `.max()` HERE, AND THAT IS DELIBERATE
// -----------------------------------------------------------------------------
//
// The size ceiling is enforced in `NoteTemplatesService.assertInstructionsFit`,
// NOT in this schema, because issue #50 requires the refusal to carry the SIZE
// in the message and `nestjs-zod`'s pipe cannot do that: a failed parse is
// rendered by `ZodValidationException` as a flat `message: "Validation failed"`
// with the issues pushed down into `details`. A user who pasted a 300 KB prompt
// would be told their request was invalid and nothing else.
//
// So the ceiling lives in exactly one place — a `BadRequestException` naming
// both the submitted size and the limit — and this comment exists so that
// nobody "tidies up" by adding a `.max()` here, which would silently win (the
// pipe runs before the service) and take the number back out of the message.
// `.describe()` below is what puts the limit into the published document.
//
// Every OTHER bound is a plain Zod rule, because none of them needs to report a
// measured number back: a name is too long or it is not, a structure entry is a
// non-empty string or it is not.
// =============================================================================

/**
 * The fixed set `note_templates.output_format` may hold.
 *
 * docs/specs/notes.md §4.3: "Meeting notes / summary / email / bullet list /
 * custom — a fixed set the editor renders as a picker." The four values the
 * seeded built-ins use (#48) are the first four; `custom` is the escape hatch
 * for a template whose shape is none of them, and `assemblePrompt` treats every
 * value identically — it is a label in the system prompt, never a branch.
 */
export const NOTE_OUTPUT_FORMATS = [
  'meeting_notes',
  'summary',
  'email',
  'bullet_list',
  'custom',
] as const;

export type NoteOutputFormat = (typeof NOTE_OUTPUT_FORMATS)[number];

/**
 * How a generated note's BODY is written (issue #334) — a second axis beside
 * `outputFormat`, which is the note's shape (meeting notes, email, …).
 *
 * `markdown` is the default and every row that predates the column carries it.
 * `plain_text` asks the model for text with no Markdown syntax, and tells the
 * exporters to render the body literally rather than parse it — an email body
 * pasted into a mail client must not arrive full of `**` and `#`.
 */
export const NOTE_BODY_FORMATS = ['markdown', 'plain_text'] as const;

export type NoteBodyFormat = (typeof NOTE_BODY_FORMATS)[number];

/** Narrow a stored `body_format` string, reading anything unrecognised as `markdown`. */
export function toNoteBodyFormat(value: unknown): NoteBodyFormat {
  return value === 'plain_text' ? 'plain_text' : 'markdown';
}

/** Characters `instructions` may hold. See the header for where it is enforced. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;

/** Entries `structure` may hold — an editor's reorderable list, not a book. */
export const MAX_STRUCTURE_SECTIONS = 40;

/** Characters one `structure` entry may hold. It is a heading, not a section. */
export const MAX_SECTION_CHARS = 200;

/** Characters a preview's `contextText` may hold (spec §3.1's orienting note). */
export const MAX_CONTEXT_CHARS = 4_000;

/** Characters a template `name` may hold. */
export const MAX_NAME_CHARS = 120;

/** Characters a template `description` may hold. */
export const MAX_DESCRIPTION_CHARS = 500;

/** Characters `tone` / `length` may hold — a picker value, not an essay. */
export const MAX_HINT_CHARS = 80;

// -----------------------------------------------------------------------------
// The shared field vocabulary
// -----------------------------------------------------------------------------

/**
 * `note_templates.structure` — THE one shape a JSON array captures and prose
 * cannot (spec §4.3): an ORDERED list of section headings, each of which has an
 * identity the editor can move, rename and delete.
 *
 * Validated as a real array of non-empty strings rather than accepted as opaque
 * JSON, because `parseTemplateStructure` (`generation/prompt.ts`) silently drops
 * anything that is not a non-empty string — so an object or a number stored here
 * would vanish from the prompt with nothing anywhere to say why. Refusing it at
 * the door turns an invisible omission into a 400 the author can act on.
 */
const structureSchema = z
  .array(z.string().trim().min(1).max(MAX_SECTION_CHARS))
  .max(MAX_STRUCTURE_SECTIONS)
  .describe(
    'Ordered list of section headings this template produces, e.g. `["Overview", "Decisions"]`. ' +
      'Order is meaningful — it is the order `assemblePrompt` numbers them in the system prompt. ' +
      `At most ${MAX_STRUCTURE_SECTIONS} entries, each a non-empty string of at most ${MAX_SECTION_CHARS} characters.`,
  );

const nameSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_CHARS)
  .describe('Display name. Unique among **your own** templates; built-ins are unaffected.');

const descriptionSchema = z
  .string()
  .trim()
  .max(MAX_DESCRIPTION_CHARS)
  .describe('One line explaining what this template produces, shown in the picker.');

const instructionsSchema = z
  .string()
  .trim()
  .min(1)
  .describe(
    'The free-text prompt body, carried verbatim into the system role. ' +
      `At most ${MAX_INSTRUCTIONS_CHARS.toLocaleString('en-US')} characters — over that the request ` +
      'is a **400** naming both the submitted size and the limit.',
  );

const outputFormatSchema = z
  .enum(NOTE_OUTPUT_FORMATS)
  .describe('Which of the fixed output shapes this template produces.');

export const bodyFormatSchema = z
  .enum(NOTE_BODY_FORMATS)
  .describe(
    'How the generated note body is written: `markdown` (the default) or `plain_text` — no ' +
      'Markdown syntax, and exported literally rather than parsed.',
  );

const toneSchema = z
  .string()
  .trim()
  .max(MAX_HINT_CHARS)
  .nullable()
  .describe('Optional tone hint (`neutral`, `warm`, …). `null` means "you decide".');

const lengthSchema = z
  .string()
  .trim()
  .max(MAX_HINT_CHARS)
  .nullable()
  .describe('Optional length hint (`short`, `medium`, …). `null` means "you decide".');

const modelSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_NAME_CHARS)
  .nullable()
  .describe(
    'Optional per-template model override. Bounded by deployment policy **at selection time** ' +
      '(`GET /api/ai/config`), never by this column — a model an administrator later withdraws is ' +
      'caught when a generation is requested, not by a constraint on the stored row.',
  );

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * `POST /api/note-templates`.
 *
 * ⚠ THERE IS NO `ownerId` FIELD, AND THERE NEVER MAY BE ONE. The owner is the
 * authenticated caller, always — a client that could name an owner could name
 * `null`, which is precisely how a user would mint a built-in and defeat §7.1's
 * whole convention. `.strict()` makes sending one a 400 rather than a field
 * quietly dropped.
 */
export const createNoteTemplateSchema = z
  .object({
    name: nameSchema,
    description: descriptionSchema.optional().default(''),
    instructions: instructionsSchema,
    outputFormat: outputFormatSchema,
    bodyFormat: bodyFormatSchema.optional().default('markdown'),
    structure: structureSchema.optional().default([]),
    tone: toneSchema.optional().default(null),
    length: lengthSchema.optional().default(null),
    model: modelSchema.optional().default(null),
  })
  .strict();

export type CreateNoteTemplateDto = z.infer<typeof createNoteTemplateSchema>;

export class CreateNoteTemplateBodyDto extends createZodDto(createNoteTemplateSchema) {}

/**
 * `PATCH /api/note-templates/{id}` — every field optional, nothing required.
 *
 * `.strict()` for the same reason `create` is strict, and `isArchived` is
 * writable here because archiving is a genuinely different action from deleting
 * (spec §4.3) and needs a way to be undone.
 */
export const updateNoteTemplateSchema = z
  .object({
    name: nameSchema.optional(),
    description: descriptionSchema.optional(),
    instructions: instructionsSchema.optional(),
    outputFormat: outputFormatSchema.optional(),
    bodyFormat: bodyFormatSchema.optional(),
    structure: structureSchema.optional(),
    tone: toneSchema.optional(),
    length: lengthSchema.optional(),
    model: modelSchema.optional(),
    isArchived: z
      .boolean()
      .optional()
      .describe('Hide from the everyday picker without deleting. Reversible.'),
  })
  .strict();

export type UpdateNoteTemplateDto = z.infer<typeof updateNoteTemplateSchema>;

export class UpdateNoteTemplateBodyDto extends createZodDto(updateNoteTemplateSchema) {}

/** `GET /api/note-templates` query string. */
export const listNoteTemplatesQuerySchema = z.object({
  includeArchived: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .default(false)
    .transform((value) => value === true || value === 'true')
    .describe('Include your archived templates. Built-ins are never archived.'),
  includeHidden: z
    .union([z.boolean(), z.enum(['true', 'false'])])
    .optional()
    .default(false)
    .transform((value) => value === true || value === 'true')
    .describe(
      'Include templates you have hidden from your own picker (built-ins included). Each item ' +
        'says whether it is hidden in `hidden`.',
    ),
});

export type ListNoteTemplatesQueryDto = z.infer<typeof listNoteTemplatesQuerySchema>;

export class ListNoteTemplatesQueryParamsDto extends createZodDto(
  listNoteTemplatesQuerySchema,
) {}

/**
 * The template body a preview may carry INLINE.
 *
 * Deliberately the same field vocabulary as `createNoteTemplateSchema` minus
 * `name`'s uniqueness burden: a preview's template is never stored, so nothing
 * about it has to be unique, and `name` exists only to become the generation's
 * `template_name_snapshot` (which is `NOT NULL`).
 */
export const inlineNoteTemplateSchema = z
  .object({
    name: nameSchema.optional().default('Untitled template'),
    instructions: instructionsSchema,
    outputFormat: outputFormatSchema,
    bodyFormat: bodyFormatSchema.optional().default('markdown'),
    structure: structureSchema.optional().default([]),
    tone: toneSchema.optional().default(null),
    length: lengthSchema.optional().default(null),
    model: modelSchema.optional().default(null),
  })
  .strict();

export type InlineNoteTemplateDto = z.infer<typeof inlineNoteTemplateSchema>;

/**
 * Which source a preview runs against.
 *
 * A discriminated union rather than four loose nullable id columns, so
 * `{ type: 'transcript', noteId: … }` cannot be expressed at all. The three
 * members are exactly `NoteSourceType`'s.
 */
export const previewSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('transcript'), transcriptId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('note'), noteId: z.string().uuid() }).strict(),
  z.object({ type: z.literal('document'), objectId: z.string().uuid() }).strict(),
]);

export type PreviewSourceDto = z.infer<typeof previewSourceSchema>;

/**
 * `POST /api/note-templates/preview`.
 *
 * ⚠ EXACTLY ONE OF `templateId` / `template`. Both is ambiguous — which one is
 * being tried? — and neither leaves nothing to generate from. The refinement
 * states it once rather than leaving the service to guess.
 *
 * Accepting `template` INLINE is the whole point of the endpoint (issue #50):
 * previewing only a SAVED template would force the user to save something they
 * have not decided they want in order to find out whether they want it, which
 * is backwards from the try-before-you-trust flow this exists for.
 */
export const previewNoteTemplateSchema = z
  .object({
    templateId: z
      .string()
      .uuid()
      .optional()
      .describe('A saved template — your own, or a built-in. Mutually exclusive with `template`.'),
    template: inlineNoteTemplateSchema
      .optional()
      .describe('An UNSAVED template body. Nothing is stored. Mutually exclusive with `templateId`.'),
    source: previewSourceSchema.describe('What to generate from. You must be able to read it.'),
    contextText: z
      .string()
      .trim()
      .max(MAX_CONTEXT_CHARS)
      .optional()
      .describe('Optional orienting note placed ahead of the source, exactly as a real note would.'),
    model: z
      .string()
      .trim()
      .min(1)
      .optional()
      .describe(
        'Override the model for this preview alone. Must be one `GET /api/ai/config` lists; ' +
          'otherwise the template\'s own `model`, otherwise the deployment default.',
      ),
  })
  .strict()
  .refine(
    (value) => (value.templateId === undefined) !== (value.template === undefined),
    { message: 'Send exactly one of `templateId` or `template`.' },
  );

export type PreviewNoteTemplateDto = z.infer<typeof previewNoteTemplateSchema>;

export class PreviewNoteTemplateBodyDto extends createZodDto(previewNoteTemplateSchema) {}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/**
 * One template, as every read returns it.
 *
 * ⚠ `builtIn` IS DERIVED FROM `ownerId IS NULL` AND `ownerId` IS NOT PUBLISHED.
 * There is no `is_built_in` column (spec §4.3) and there is no second,
 * independently-settable statement of the fact on the wire either: a client
 * reads one boolean and cannot be handed two that disagree. `ownerId` itself is
 * withheld because the only two values it can have for a caller are "null" and
 * "you", and `builtIn` already says which.
 */
export const noteTemplateResponseSchema = z.object({
  id: z.string().describe('The template id.'),
  name: nameSchema,
  description: descriptionSchema,
  instructions: z.string().describe('The free-text prompt body, verbatim.'),
  outputFormat: outputFormatSchema,
  bodyFormat: bodyFormatSchema,
  structure: structureSchema,
  tone: toneSchema,
  length: lengthSchema,
  model: modelSchema,
  isArchived: z.boolean().describe('Hidden from the everyday picker. Always false for a built-in.'),
  builtIn: z
    .boolean()
    .describe(
      'Seeded and owned by nobody. Readable by every user, **editable by none** — `PATCH` and ' +
        '`DELETE` answer **403**. Duplicate it to get an editable copy.',
    ),
  hidden: z
    .boolean()
    .describe(
      'Hidden from **your own** picker (issue #310). Per-user: hiding a built-in changes nothing ' +
        'on the shared row and nothing for anybody else. A hidden template still works — an ' +
        'existing note keeps it, and it can still be generated from, previewed and duplicated.',
    ),
  // ⚠ `z.string()`, NOT `z.date()`: these schemas ALSO generate the published
  // OpenAPI document, and a `z.date()` is not expressible as JSON Schema (it
  // throws at document build). ISO-8601 strings are what actually crosses the
  // wire, so describing them is both accurate and buildable — the same choice
  // `transcript.dto.ts` already makes.
  createdAt: z.string().describe('When the row was created (ISO 8601).'),
  updatedAt: z.string().describe('When the row last changed (ISO 8601).'),
});

export type NoteTemplateResponse = z.infer<typeof noteTemplateResponseSchema>;

export class NoteTemplateDto extends createZodDto(noteTemplateResponseSchema) {}

/** `GET /api/note-templates`. */
export const noteTemplateListResponseSchema = z.object({
  items: z
    .array(noteTemplateResponseSchema)
    .describe('Your own templates and every built-in, in one list, each flagged `builtIn`.'),
  total: z.number().describe('How many templates are in `items`. The list is not paginated.'),
});

export class NoteTemplateListDto extends createZodDto(noteTemplateListResponseSchema) {}

/**
 * `DELETE /api/note-templates/{id}` — which of the two things happened.
 *
 * A `DELETE` that archives is not a failure and must not be reported as one, so
 * the outcome is data rather than a status-code distinction: the client shows
 * "archived, because 3 notes were generated from it" instead of "deleted" and
 * the row is still there to duplicate from.
 */
export const deleteNoteTemplateResponseSchema = z.object({
  id: z.string().describe('The template acted on.'),
  outcome: z
    .enum(['deleted', 'archived'])
    .describe(
      '`deleted` when nothing referenced the template. `archived` when notes still name it — ' +
        'the row survives, hidden from the picker, and **every referencing note keeps its ' +
        '`templateId`**.',
    ),
  noteCount: z.number().describe('Notes that reference this template. Nonzero forces `archived`.'),
});

export class DeleteNoteTemplateResultDto extends createZodDto(
  deleteNoteTemplateResponseSchema,
) {}

/**
 * `POST /api/note-templates/preview`.
 *
 * ⚠ THE DESCRIPTIONS HERE SAY, IN SO MANY WORDS, THAT THIS SPENDS THE CALLER'S
 * OWN MONEY. Issue #50 requires it: a preview is a REAL generation against the
 * user's own vendor account, indistinguishable from a note's generation in
 * every way except that it produces no note. A response that quietly returned
 * an id would leave the only statement of that fact in the UI copy of one
 * screen (#56), where a second client would never see it.
 */
export const previewNoteTemplateResponseSchema = z.object({
  generationId: z
    .string()
    .describe(
      'The `note_generations` row this preview streams into. Attach to it exactly as you would a ' +
        "note's own generation — it is the same row, produced by the same `note.generate` job.",
    ),
  kind: z
    .literal('preview')
    .describe('Always `preview`. It has no `noteId`, creates no note, and appears in no note list.'),
  status: z.literal('pending').describe('Always `pending` on creation; the job moves it from there.'),
  jobId: z.string().describe('The `note.generate` job queued for it.'),
  templateId: z
    .string()
    .nullable()
    .describe('The saved template previewed, or `null` when an unsaved body was sent inline.'),
  templateName: z.string().describe('The name recorded on the generation row.'),
  providerId: z.string().describe('The AI provider this preview was submitted to.'),
  model: z.string().describe('The model it will use. ⚠ Billed to **your** account, not the deployment\'s.'),
  expiresAt: z
    .string()
    .describe(
      'ISO 8601. When `notes.housekeeping` hard-deletes this row. A preview is disposable by ' +
        'construction — read it while it is there or generate it again.',
    ),
});

export type PreviewNoteTemplateResponse = z.infer<typeof previewNoteTemplateResponseSchema>;

export class PreviewNoteTemplateResultDto extends createZodDto(
  previewNoteTemplateResponseSchema,
) {}
