import { createZodDto } from 'nestjs-zod';
import {
  createNoteTemplateSchema,
  updateNoteTemplateSchema,
  listNoteTemplatesQuerySchema,
  previewNoteTemplateSchema,
  noteTemplateResponseSchema,
  noteTemplateListResponseSchema,
  deleteNoteTemplateResponseSchema,
  previewNoteTemplateResponseSchema,
} from '@marinoscar/kvox-contract/notes';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/notes` (issue #488, file `notes/note-template.ts`); they are re-exported below so no importer changes.
export {
  NOTE_OUTPUT_FORMATS,
  type NoteOutputFormat,
  NOTE_BODY_FORMATS,
  type NoteBodyFormat,
  toNoteBodyFormat,
  MAX_INSTRUCTIONS_CHARS,
  MAX_STRUCTURE_SECTIONS,
  MAX_SECTION_CHARS,
  MAX_CONTEXT_CHARS,
  MAX_NAME_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_HINT_CHARS,
  bodyFormatSchema,
  createNoteTemplateSchema,
  type CreateNoteTemplateDto,
  updateNoteTemplateSchema,
  type UpdateNoteTemplateDto,
  listNoteTemplatesQuerySchema,
  type ListNoteTemplatesQueryDto,
  inlineNoteTemplateSchema,
  type InlineNoteTemplateDto,
  previewSourceSchema,
  type PreviewSourceDto,
  previewNoteTemplateSchema,
  type PreviewNoteTemplateDto,
  noteTemplateResponseSchema,
  type NoteTemplateResponse,
  noteTemplateListResponseSchema,
  deleteNoteTemplateResponseSchema,
  previewNoteTemplateResponseSchema,
  type PreviewNoteTemplateResponse,
} from '@marinoscar/kvox-contract/notes';

export class CreateNoteTemplateBodyDto extends createZodDto(createNoteTemplateSchema) {}

export class UpdateNoteTemplateBodyDto extends createZodDto(updateNoteTemplateSchema) {}

export class ListNoteTemplatesQueryParamsDto extends createZodDto(
  listNoteTemplatesQuerySchema,
) {}

export class PreviewNoteTemplateBodyDto extends createZodDto(previewNoteTemplateSchema) {}

export class NoteTemplateDto extends createZodDto(noteTemplateResponseSchema) {}

export class NoteTemplateListDto extends createZodDto(noteTemplateListResponseSchema) {}

export class DeleteNoteTemplateResultDto extends createZodDto(
  deleteNoteTemplateResponseSchema,
) {}

export class PreviewNoteTemplateResultDto extends createZodDto(
  previewNoteTemplateResponseSchema,
) {}
