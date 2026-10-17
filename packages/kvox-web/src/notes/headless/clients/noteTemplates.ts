/**
 * The Note Templates API, as the web app sees it — issue #56, epic #45.
 *
 * Shaped after the transcripts client: `KvoxWebHost` stays the transport (every
 * call takes it first), and this module holds the calls next to the types they
 * produce.
 *
 * =============================================================================
 * THE TWO REFUSALS ARE NOT INTERCHANGEABLE, AND THIS MODULE DOES NOT FLATTEN THEM
 * =============================================================================
 *
 * `note-templates.controller.ts` answers **403** for a write against a BUILT-IN
 * and **404** for a write against ANOTHER USER'S template — deliberately
 * different codes for deliberately different facts (a built-in's existence is
 * public; a stranger's is not). Nothing here collapses them into one "failed"
 * string, because the UI's answer to each is different: a built-in is offered a
 * Duplicate, a 404 is a list that has gone stale.
 *
 * In practice the web UI never provokes the 403 at all — the list view renders
 * no Edit affordance on a built-in row in the first place (issue #56: "absent,
 * not present-and-failing"). The distinction survives here anyway so a caller
 * that hits it out of a stale list can say something true.
 *
 * =============================================================================
 * ⚠ `PREVIEW` SPENDS THE CALLER'S OWN MONEY
 * =============================================================================
 *
 * `POST /api/note-templates/preview` is a REAL generation on the user's own
 * provider account — the same job, the same prompt assembly, the same billing
 * as a real note. There is no cheaper simulated path, deliberately. Every
 * surface that calls `previewNoteTemplate` must say so BEFORE the control is
 * pressed; `ui/components/PreviewCostNotice.tsx` is the one piece of copy
 * that does it, so the statement cannot drift between surfaces.
 *
 * =============================================================================
 * THE INLINE PREVIEW BODY IS NOT THE SAVE BODY, AND THE DIFFERENCE MATTERS
 * =============================================================================
 *
 * `inlineNoteTemplateSchema` on the API is `.strict()` and carries NO
 * `description` (a preview stores nothing, so there is nothing for a
 * description to describe). Sending the editor's whole draft — which does hold
 * a description — would be a **400** on a request the user believes is simply
 * "try this". `toInlineTemplate` below is the one narrowing, so no caller
 * assembles that body by hand.
 */

import type {
  NoteBodyFormat as ContractNoteBodyFormat,
  NoteOutputFormat as ContractNoteOutputFormat,
} from '@marinoscar/kvox-contract/notes';

import { kvoxDelete, kvoxGet, kvoxPatch, kvoxPost, kvoxPut } from '../../../core/headless/index.js';
import type { KvoxWebHost } from '../../../core/headless/index.js';

// =============================================================================
// Types
// =============================================================================

/**
 * `note_templates.output_format` — the fixed set, mirroring
 * `NOTE_OUTPUT_FORMATS` in `packages/kvox-api/src/notes/dto/note-template.dto.ts`.
 *
 * A UNION OF LITERALS rather than `string`, so a picker that offered a value
 * the API would refuse could not be written. The labels live beside it because
 * the API publishes the values and not their display names.
  *
  * @stability experimental
 */
export const NOTE_OUTPUT_FORMATS = [
  'meeting_notes',
  'summary',
  'email',
  'bullet_list',
  'custom',
] as const;

/**
 * One member of {@link NOTE_OUTPUT_FORMATS}.
 *
 * @stability experimental
 */
export type NoteOutputFormat = ContractNoteOutputFormat;

/**
 * How each output format is named on screen.
 *
 * @stability experimental
 */
export const NOTE_OUTPUT_FORMAT_LABELS: Record<NoteOutputFormat, string> = {
  meeting_notes: 'Meeting notes',
  summary: 'Summary',
  email: 'Email',
  bullet_list: 'Bullet list',
  custom: 'Custom',
};

/**
 * `note_templates.body_format` — issue #334. What shape of text the AI is asked
 * to produce: `markdown` (headings, lists, bold) or `plain_text` (no formatting
 * symbols at all). Mirrors the API's own enum; `markdown` is the default, and a
 * row read from a server that predates the field is treated as `markdown`.
  *
  * @stability experimental
 */
export const NOTE_BODY_FORMATS = ['markdown', 'plain_text'] as const;

/**
 * One member of {@link NOTE_BODY_FORMATS}.
 *
 * @stability experimental
 */
export type NoteBodyFormat = ContractNoteBodyFormat;

/**
 * How each body format is named on screen.
 *
 * @stability experimental
 */
export const NOTE_BODY_FORMAT_LABELS: Record<NoteBodyFormat, string> = {
  markdown: 'Markdown (rich text)',
  plain_text: 'Plain text',
};

/**
 * The default body format, and what an absent field means.
 *
 * @stability experimental
 */
export const DEFAULT_NOTE_BODY_FORMAT: NoteBodyFormat = 'markdown';

/**
 * A possibly-absent wire value, normalised — missing means `markdown`.
 *
 * @stability experimental
 */
export function effectiveBodyFormat(value: NoteBodyFormat | null | undefined): NoteBodyFormat {
  return value === 'plain_text' ? 'plain_text' : 'markdown';
}

/**
 * The API's own ceilings, mirrored so the form can refuse before the server does.
 *
 * @stability experimental
 */
export const MAX_INSTRUCTIONS_CHARS = 20_000;
/**
 * Most headings a template's structure may hold.
 *
 * @stability experimental
 */
export const MAX_STRUCTURE_SECTIONS = 40;
/**
 * Most characters one heading may hold.
 *
 * @stability experimental
 */
export const MAX_SECTION_CHARS = 200;
/**
 * Most characters a template's name may hold.
 *
 * @stability experimental
 */
export const MAX_NAME_CHARS = 120;
/**
 * Most characters a template's description may hold.
 *
 * @stability experimental
 */
export const MAX_DESCRIPTION_CHARS = 500;
/**
 * Most characters a template's tone or length hint may hold.
 *
 * @stability experimental
 */
export const MAX_HINT_CHARS = 80;

/**
 * One template, as every read returns it.
 *
 * ⚠ `builtIn` IS THE ONLY STATEMENT OF OWNERSHIP ON THE WIRE. There is no
 * `ownerId` — the API withholds it because its only two values for a caller are
 * "null" and "you", and this boolean already says which. Every affordance
 * decision in the list view reads this field and nothing else.
  *
  * @stability experimental
 */
export interface NoteTemplate {
  /** The template's id. */
  id: string;
  /** The template's name. */
  name: string;
  /** A one-line description, or `null`. */
  description: string;
  /** What the AI is asked to do. */
  instructions: string;
  /** The kind of output the template produces. */
  outputFormat: NoteOutputFormat;
  /**
   * Issue #334. Optional on the wire type only because a server predating the
   * field omits it; read it through {@link effectiveBodyFormat}.
   */
  bodyFormat?: NoteBodyFormat;
  /** The section headings the output should follow, in order. */
  structure: string[];
  /** The tone the output should take, or `null`. */
  tone: string | null;
  /** How long the output should be, or `null`. */
  length: string | null;
  /** A model the template pins, or `null` for the default. */
  model: string | null;
  /** Whether the template is archived. */
  isArchived: boolean;
  /** Whether the template ships with the application (it cannot be edited, only duplicated). */
  builtIn: boolean;
  /**
   * Hidden from the CALLER's template pickers (issue #311). A per-viewer
   * preference, not a property of the template: a built-in can be hidden too,
   * and hiding never changes what anybody else sees. The list endpoint omits
   * hidden rows unless asked with `includeHidden`.
   */
  hidden: boolean;
  /** When it was created, as an ISO timestamp. */
  createdAt: string;
  /** When it last changed, as an ISO timestamp. */
  updatedAt: string;
}

/**
 * `GET /api/note-templates` — your own plus every built-in, unpaginated.
 *
 * @stability experimental
 */
export interface NoteTemplateList {
  /** Your own templates plus every built-in. */
  items: NoteTemplate[];
  /** How many templates there are. */
  total: number;
}

/**
 * `POST /api/note-templates`. There is no owner field and there never may be one.
 *
 * @stability experimental
 */
export interface CreateNoteTemplateInput {
  /** The name. */
  name: string;
  /** A one-line description. */
  description?: string;
  /** What the AI is asked to do. */
  instructions: string;
  /** The kind of output the template produces. */
  outputFormat: NoteOutputFormat;
  /** The shape of the generated text: markdown or plain text. */
  bodyFormat?: NoteBodyFormat;
  /** The section headings the output should follow, in order. */
  structure?: string[];
  /** The tone the output should take, or `null`. */
  tone?: string | null;
  /** How long the output should be, or `null`. */
  length?: string | null;
  /** The model id, or `null` for the default. */
  model?: string | null;
}

/**
 * `PATCH /api/note-templates/{id}` — every field optional.
 *
 * @stability experimental
 */
export type UpdateNoteTemplateInput = Partial<CreateNoteTemplateInput> & {
  /** Archives or restores the template. */
  isArchived?: boolean;
};

/**
 * `DELETE /api/note-templates/{id}`.
 *
 * `archived` IS NOT A FAILURE. The API archives rather than deletes when notes
 * still reference the template, and says which happened here — so the UI can
 * report the truth instead of claiming a deletion that did not occur.
  *
  * @stability experimental
 */
export interface DeleteNoteTemplateResult {
  /** The template that was removed. */
  id: string;
  /** `deleted` when the row is gone, `archived` when notes still reference it. */
  outcome: 'deleted' | 'archived';
  /** How many notes reference the template. */
  noteCount: number;
}

/**
 * What a preview generates from. The API's discriminated union, exactly.
 *
 * @stability experimental
 */
export type PreviewSource =
  | {
      /** A transcript. */
      type: 'transcript';
      /** The transcript to preview against. */
      transcriptId: string;
    }
  | {
      /** Another note. */
      type: 'note';
      /** The note to preview against. */
      noteId: string;
    }
  | {
      /** An uploaded document. */
      type: 'document';
      /** The document to preview against. */
      objectId: string;
    };

/**
 * The UNSAVED template body a preview carries inline.
 *
 * ⚠ NO `description`, NO `isArchived`, NO `id`. The API's
 * `inlineNoteTemplateSchema` is `.strict()`, so any extra key is a 400. Build
 * it with {@link toInlineTemplate} rather than by hand.
  *
  * @stability experimental
 */
export interface InlineNoteTemplate {
  /** The template's name. */
  name?: string;
  /** What the AI is asked to do. */
  instructions: string;
  /** The kind of output the template produces. */
  outputFormat: NoteOutputFormat;
  /** The shape of the generated text: markdown or plain text. */
  bodyFormat?: NoteBodyFormat;
  /** The section headings the output should follow, in order. */
  structure?: string[];
  /** The tone the output should take, or `null`. */
  tone?: string | null;
  /** How long the output should be, or `null`. */
  length?: string | null;
  /** The model id, or `null` for the default. */
  model?: string | null;
}

/**
 * `POST /api/note-templates/preview`.
 *
 * ⚠ EXACTLY ONE OF `templateId` / `template`. Both is ambiguous and neither
 * leaves nothing to generate from; the API refines on it, and this type cannot
 * express the requirement, so `previewNoteTemplate` is the only thing that
 * builds one.
  *
  * @stability experimental
 */
export interface PreviewNoteTemplateInput {
  /** A saved template to preview. Give this or `template`. */
  templateId?: string;
  /** An unsaved template to preview. Give this or `templateId`. */
  template?: InlineNoteTemplate;
  /** What to preview against. */
  source: PreviewSource;
  /** Extra context for the sample. */
  contextText?: string;
  /** A model to run the sample on. */
  model?: string;
}

/**
 * The 202 body. `generationId` is what the SSE stream is addressed by.
 *
 * @stability experimental
 */
export interface NoteTemplatePreview {
  /** The generation to attach to. */
  generationId: string;
  /** Always `preview`. */
  kind: 'preview';
  /** Where the generation is. */
  status: 'pending';
  /** The queue job doing the work. */
  jobId: string;
  /** The saved template previewed, or `null` for an unsaved one. */
  templateId: string | null;
  /** The name of the template previewed. */
  templateName: string;
  /** The AI provider the generation runs on. */
  providerId: string;
  /** ⚠ Billed to the CALLER's provider account, not the deployment's. */
  model: string;
  /** When the sample is swept, as an ISO timestamp. */
  expiresAt: string;
}

// =============================================================================
// Calls
// =============================================================================

const BASE = '/note-templates';

/**
 * `GET /api/note-templates` — `note_templates:read`.
 *
 * Hidden templates are EXCLUDED unless `includeHidden` is set — the default is
 * what a picker wants, so only the template manager has to ask for more. Each
 * flag is sent only when set, so the default request stays the bare path.
  *
  * @stability experimental
 */
export async function getNoteTemplates(
  host: KvoxWebHost,
  options: { includeArchived?: boolean; includeHidden?: boolean } = {},
): Promise<NoteTemplateList> {
  const params = new URLSearchParams();
  if (options.includeArchived) params.set('includeArchived', 'true');
  if (options.includeHidden) params.set('includeHidden', 'true');
  const query = params.toString();
  return kvoxGet<NoteTemplateList>(host, `${BASE}${query ? `?${query}` : ''}`);
}

/**
 * `GET /api/note-templates/{id}`. Anything not yours and not a built-in is a 404.
 *
 * @stability experimental
 */
export async function getNoteTemplate(host: KvoxWebHost, id: string): Promise<NoteTemplate> {
  return kvoxGet<NoteTemplate>(host, `${BASE}/${encodeURIComponent(id)}`);
}

/**
 * `POST /api/note-templates` — the new row is always the caller's.
 *
 * @stability experimental
 */
export async function createNoteTemplate(
  host: KvoxWebHost,
  input: CreateNoteTemplateInput,
): Promise<NoteTemplate> {
  return kvoxPost<NoteTemplate>(host, BASE, input);
}

/**
 * `PATCH /api/note-templates/{id}` — yours only; a built-in answers 403.
 *
 * @stability experimental
 */
export async function updateNoteTemplate(
  host: KvoxWebHost,
  id: string,
  input: UpdateNoteTemplateInput,
): Promise<NoteTemplate> {
  return kvoxPatch<NoteTemplate>(host, `${BASE}/${encodeURIComponent(id)}`, input);
}

/**
 * `DELETE /api/note-templates/{id}` — deletes, or archives. Read `outcome`.
 *
 * @stability experimental
 */
export async function deleteNoteTemplate(
  host: KvoxWebHost,
  id: string,
): Promise<DeleteNoteTemplateResult> {
  return kvoxDelete<DeleteNoteTemplateResult>(host, `${BASE}/${encodeURIComponent(id)}`);
}

/**
 * `PUT /api/note-templates/{id}/hidden` — **204**, idempotent.
 *
 * Allowed on built-ins (hiding is the caller's preference, not an edit of the
 * row); a template the caller cannot read is a 404.
  *
  * @stability experimental
 */
export async function hideNoteTemplate(host: KvoxWebHost, id: string): Promise<void> {
  await kvoxPut<void>(host, `${BASE}/${encodeURIComponent(id)}/hidden`, {});
}

/**
 * `DELETE /api/note-templates/{id}/hidden` — **204**, idempotent.
 *
 * @stability experimental
 */
export async function unhideNoteTemplate(host: KvoxWebHost, id: string): Promise<void> {
  await kvoxDelete<void>(host, `${BASE}/${encodeURIComponent(id)}/hidden`);
}

/**
 * `POST /api/note-templates/{id}/duplicate` — **how a built-in is customised.**
 *
 * Works against anything the caller can read and produces a new row they own,
 * with every column copied. This is the affordance a built-in row offers
 * instead of an Edit it could never satisfy.
  *
  * @stability experimental
 */
export async function duplicateNoteTemplate(host: KvoxWebHost, id: string): Promise<NoteTemplate> {
  return kvoxPost<NoteTemplate>(host, `${BASE}/${encodeURIComponent(id)}/duplicate`, {});
}

/**
 * `POST /api/note-templates/preview` — **202, and a real charge on the caller's
 * own provider account.**
 *
 * Returns the generation to attach to; the tokens arrive over
 * `noteGenerationStream.ts`, never in this response.
  *
  * @stability experimental
 */
export async function previewNoteTemplate(
  host: KvoxWebHost,
  input: PreviewNoteTemplateInput,
): Promise<NoteTemplatePreview> {
  return kvoxPost<NoteTemplatePreview>(host, `${BASE}/preview`, input);
}

// =============================================================================
// Narrowing an editor draft into what the API will accept
// =============================================================================

/**
 * Everything the editor holds, including the fields a preview must not send.
 *
 * @stability experimental
 */
export interface NoteTemplateDraft {
  /** The name. */
  name: string;
  /** A one-line description. */
  description: string;
  /** What the AI is asked to do. */
  instructions: string;
  /** The kind of output the template produces. */
  outputFormat: NoteOutputFormat;
  /** The shape of the generated text: markdown or plain text. */
  bodyFormat: NoteBodyFormat;
  /** The section headings the output should follow, in order. */
  structure: string[];
  /** The tone the output should take, or `null`. */
  tone: string;
  /** How long the output should be, or `null`. */
  length: string;
  /** The model id, or `null` for the default. */
  model: string;
}

/** `''` means "you decide", which on the wire is `null`, not an empty string. */
function hintOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** Blank rows a user left behind in the structure list are not sections. */
function cleanStructure(structure: string[]): string[] {
  return structure.map((entry) => entry.trim()).filter((entry) => entry !== '');
}

/**
 * The editor's draft, narrowed to the body `POST /preview` accepts.
 *
 * ⚠ THIS IS WHAT MAKES "PREVIEW TESTS WHAT IS ON SCREEN" TRUE. It reads the
 * live draft and nothing else — never a saved row, never a last-known-good
 * copy — which is the behaviour issue #56's whole flow depends on and which
 * `UserNoteTemplatesPage.test.tsx` asserts against the request body.
 *
 * `description` is DROPPED rather than forgotten: the API's inline schema is
 * `.strict()` and has no such key, so sending it turns a preview into a 400.
  *
  * @stability experimental
 */
export function toInlineTemplate(draft: NoteTemplateDraft): InlineNoteTemplate {
  return {
    // A nameless draft still needs a name — it becomes the generation row's
    // `template_name_snapshot`, which is NOT NULL. The API defaults it too;
    // doing it here means the user sees the same word the server records.
    name: draft.name.trim() === '' ? 'Untitled template' : draft.name.trim(),
    instructions: draft.instructions,
    outputFormat: draft.outputFormat,
    bodyFormat: draft.bodyFormat,
    structure: cleanStructure(draft.structure),
    tone: hintOrNull(draft.tone),
    length: hintOrNull(draft.length),
    model: hintOrNull(draft.model),
  };
}

/**
 * The editor's draft, as `POST /api/note-templates` accepts it.
 *
 * @stability experimental
 */
export function toCreateInput(draft: NoteTemplateDraft): CreateNoteTemplateInput {
  return {
    name: draft.name.trim(),
    description: draft.description.trim(),
    instructions: draft.instructions,
    outputFormat: draft.outputFormat,
    bodyFormat: draft.bodyFormat,
    structure: cleanStructure(draft.structure),
    tone: hintOrNull(draft.tone),
    length: hintOrNull(draft.length),
    model: hintOrNull(draft.model),
  };
}

/**
 * The editor's draft, as `PATCH /api/note-templates/{id}` accepts it.
 *
 * @stability experimental
 */
export function toUpdateInput(draft: NoteTemplateDraft): UpdateNoteTemplateInput {
  return toCreateInput(draft);
}

/**
 * A saved row, opened in the editor. `null` hints become empty boxes.
 *
 * @stability experimental
 */
export function draftFromTemplate(template: NoteTemplate): NoteTemplateDraft {
  return {
    name: template.name,
    description: template.description,
    instructions: template.instructions,
    outputFormat: template.outputFormat,
    bodyFormat: effectiveBodyFormat(template.bodyFormat),
    structure: [...template.structure],
    tone: template.tone ?? '',
    length: template.length ?? '',
    model: template.model ?? '',
  };
}

/**
 * A brand-new template, before the user has typed anything.
 *
 * @stability experimental
 */
export function emptyDraft(): NoteTemplateDraft {
  return {
    name: '',
    description: '',
    instructions: '',
    outputFormat: 'meeting_notes',
    bodyFormat: DEFAULT_NOTE_BODY_FORMAT,
    structure: [],
    tone: '',
    length: '',
    model: '',
  };
}
