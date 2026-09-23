/**
 * The Note Templates API, as the web app sees it — issue #56, epic #45.
 *
 * Shaped after `services/ai.ts` and `services/transcripts.ts`:
 * `services/api.ts` stays the transport, and this module holds the calls next
 * to the types they produce.
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
 * pressed; `components/notes/PreviewCostNotice.tsx` is the one piece of copy
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

import { api } from './api';

// =============================================================================
// Types
// =============================================================================

/**
 * `note_templates.output_format` — the fixed set, mirroring
 * `NOTE_OUTPUT_FORMATS` in `apps/api/src/notes/dto/note-template.dto.ts`.
 *
 * A UNION OF LITERALS rather than `string`, so a picker that offered a value
 * the API would refuse could not be written. The labels live beside it because
 * the API publishes the values and not their display names.
 */
export const NOTE_OUTPUT_FORMATS = [
  'meeting_notes',
  'summary',
  'email',
  'bullet_list',
  'custom',
] as const;

export type NoteOutputFormat = (typeof NOTE_OUTPUT_FORMATS)[number];

/** How each output format is named on screen. */
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
 */
export const NOTE_BODY_FORMATS = ['markdown', 'plain_text'] as const;

export type NoteBodyFormat = (typeof NOTE_BODY_FORMATS)[number];

/** How each body format is named on screen. */
export const NOTE_BODY_FORMAT_LABELS: Record<NoteBodyFormat, string> = {
  markdown: 'Markdown (rich text)',
  plain_text: 'Plain text',
};

/** The default body format, and what an absent field means. */
export const DEFAULT_NOTE_BODY_FORMAT: NoteBodyFormat = 'markdown';

/** A possibly-absent wire value, normalised — missing means `markdown`. */
export function effectiveBodyFormat(value: NoteBodyFormat | null | undefined): NoteBodyFormat {
  return value === 'plain_text' ? 'plain_text' : 'markdown';
}

/** The API's own ceilings, mirrored so the form can refuse before the server does. */
export const MAX_INSTRUCTIONS_CHARS = 20_000;
export const MAX_STRUCTURE_SECTIONS = 40;
export const MAX_SECTION_CHARS = 200;
export const MAX_NAME_CHARS = 120;
export const MAX_DESCRIPTION_CHARS = 500;
export const MAX_HINT_CHARS = 80;

/**
 * One template, as every read returns it.
 *
 * ⚠ `builtIn` IS THE ONLY STATEMENT OF OWNERSHIP ON THE WIRE. There is no
 * `ownerId` — the API withholds it because its only two values for a caller are
 * "null" and "you", and this boolean already says which. Every affordance
 * decision in the list view reads this field and nothing else.
 */
export interface NoteTemplate {
  id: string;
  name: string;
  description: string;
  instructions: string;
  outputFormat: NoteOutputFormat;
  /**
   * Issue #334. Optional on the wire type only because a server predating the
   * field omits it; read it through {@link effectiveBodyFormat}.
   */
  bodyFormat?: NoteBodyFormat;
  structure: string[];
  tone: string | null;
  length: string | null;
  model: string | null;
  isArchived: boolean;
  builtIn: boolean;
  /**
   * Hidden from the CALLER's template pickers (issue #311). A per-viewer
   * preference, not a property of the template: a built-in can be hidden too,
   * and hiding never changes what anybody else sees. The list endpoint omits
   * hidden rows unless asked with `includeHidden`.
   */
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
}

/** `GET /api/note-templates` — your own plus every built-in, unpaginated. */
export interface NoteTemplateList {
  items: NoteTemplate[];
  total: number;
}

/** `POST /api/note-templates`. There is no owner field and there never may be one. */
export interface CreateNoteTemplateInput {
  name: string;
  description?: string;
  instructions: string;
  outputFormat: NoteOutputFormat;
  bodyFormat?: NoteBodyFormat;
  structure?: string[];
  tone?: string | null;
  length?: string | null;
  model?: string | null;
}

/** `PATCH /api/note-templates/{id}` — every field optional. */
export type UpdateNoteTemplateInput = Partial<CreateNoteTemplateInput> & {
  isArchived?: boolean;
};

/**
 * `DELETE /api/note-templates/{id}`.
 *
 * `archived` IS NOT A FAILURE. The API archives rather than deletes when notes
 * still reference the template, and says which happened here — so the UI can
 * report the truth instead of claiming a deletion that did not occur.
 */
export interface DeleteNoteTemplateResult {
  id: string;
  outcome: 'deleted' | 'archived';
  noteCount: number;
}

/** What a preview generates from. The API's discriminated union, exactly. */
export type PreviewSource =
  | { type: 'transcript'; transcriptId: string }
  | { type: 'note'; noteId: string }
  | { type: 'document'; objectId: string };

/**
 * The UNSAVED template body a preview carries inline.
 *
 * ⚠ NO `description`, NO `isArchived`, NO `id`. The API's
 * `inlineNoteTemplateSchema` is `.strict()`, so any extra key is a 400. Build
 * it with {@link toInlineTemplate} rather than by hand.
 */
export interface InlineNoteTemplate {
  name?: string;
  instructions: string;
  outputFormat: NoteOutputFormat;
  bodyFormat?: NoteBodyFormat;
  structure?: string[];
  tone?: string | null;
  length?: string | null;
  model?: string | null;
}

/**
 * `POST /api/note-templates/preview`.
 *
 * ⚠ EXACTLY ONE OF `templateId` / `template`. Both is ambiguous and neither
 * leaves nothing to generate from; the API refines on it, and this type cannot
 * express the requirement, so `previewNoteTemplate` is the only thing that
 * builds one.
 */
export interface PreviewNoteTemplateInput {
  templateId?: string;
  template?: InlineNoteTemplate;
  source: PreviewSource;
  contextText?: string;
  model?: string;
}

/** The 202 body. `generationId` is what the SSE stream is addressed by. */
export interface NoteTemplatePreview {
  generationId: string;
  kind: 'preview';
  status: 'pending';
  jobId: string;
  templateId: string | null;
  templateName: string;
  providerId: string;
  /** ⚠ Billed to the CALLER's provider account, not the deployment's. */
  model: string;
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
 */
export async function getNoteTemplates(
  options: { includeArchived?: boolean; includeHidden?: boolean } = {},
): Promise<NoteTemplateList> {
  const params = new URLSearchParams();
  if (options.includeArchived) params.set('includeArchived', 'true');
  if (options.includeHidden) params.set('includeHidden', 'true');
  const query = params.toString();
  return api.get<NoteTemplateList>(`${BASE}${query ? `?${query}` : ''}`);
}

/** `GET /api/note-templates/{id}`. Anything not yours and not a built-in is a 404. */
export async function getNoteTemplate(id: string): Promise<NoteTemplate> {
  return api.get<NoteTemplate>(`${BASE}/${encodeURIComponent(id)}`);
}

/** `POST /api/note-templates` — the new row is always the caller's. */
export async function createNoteTemplate(
  input: CreateNoteTemplateInput,
): Promise<NoteTemplate> {
  return api.post<NoteTemplate>(BASE, input);
}

/** `PATCH /api/note-templates/{id}` — yours only; a built-in answers 403. */
export async function updateNoteTemplate(
  id: string,
  input: UpdateNoteTemplateInput,
): Promise<NoteTemplate> {
  return api.patch<NoteTemplate>(`${BASE}/${encodeURIComponent(id)}`, input);
}

/** `DELETE /api/note-templates/{id}` — deletes, or archives. Read `outcome`. */
export async function deleteNoteTemplate(
  id: string,
): Promise<DeleteNoteTemplateResult> {
  return api.delete<DeleteNoteTemplateResult>(`${BASE}/${encodeURIComponent(id)}`);
}

/**
 * `PUT /api/note-templates/{id}/hidden` — **204**, idempotent.
 *
 * Allowed on built-ins (hiding is the caller's preference, not an edit of the
 * row); a template the caller cannot read is a 404.
 */
export async function hideNoteTemplate(id: string): Promise<void> {
  await api.put<void>(`${BASE}/${encodeURIComponent(id)}/hidden`, {});
}

/** `DELETE /api/note-templates/{id}/hidden` — **204**, idempotent. */
export async function unhideNoteTemplate(id: string): Promise<void> {
  await api.delete<void>(`${BASE}/${encodeURIComponent(id)}/hidden`);
}

/**
 * `POST /api/note-templates/{id}/duplicate` — **how a built-in is customised.**
 *
 * Works against anything the caller can read and produces a new row they own,
 * with every column copied. This is the affordance a built-in row offers
 * instead of an Edit it could never satisfy.
 */
export async function duplicateNoteTemplate(id: string): Promise<NoteTemplate> {
  return api.post<NoteTemplate>(`${BASE}/${encodeURIComponent(id)}/duplicate`, {});
}

/**
 * `POST /api/note-templates/preview` — **202, and a real charge on the caller's
 * own provider account.**
 *
 * Returns the generation to attach to; the tokens arrive over
 * `services/noteGenerationStream.ts`, never in this response.
 */
export async function previewNoteTemplate(
  input: PreviewNoteTemplateInput,
): Promise<NoteTemplatePreview> {
  return api.post<NoteTemplatePreview>(`${BASE}/preview`, input);
}

// =============================================================================
// Narrowing an editor draft into what the API will accept
// =============================================================================

/** Everything the editor holds, including the fields a preview must not send. */
export interface NoteTemplateDraft {
  name: string;
  description: string;
  instructions: string;
  outputFormat: NoteOutputFormat;
  bodyFormat: NoteBodyFormat;
  structure: string[];
  tone: string;
  length: string;
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

/** The editor's draft, as `POST /api/note-templates` accepts it. */
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

/** The editor's draft, as `PATCH /api/note-templates/{id}` accepts it. */
export function toUpdateInput(draft: NoteTemplateDraft): UpdateNoteTemplateInput {
  return toCreateInput(draft);
}

/** A saved row, opened in the editor. `null` hints become empty boxes. */
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

/** A brand-new template, before the user has typed anything. */
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
