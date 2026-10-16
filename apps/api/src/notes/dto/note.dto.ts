import { createZodDto } from 'nestjs-zod';
import {
  createNoteSchema,
  updateNoteSchema,
  regenerateNoteSchema,
  restoreNoteVersionSchema,
  noteListQuerySchema,
  noteVersionsQuerySchema,
  noteResponseSchema,
  noteListResponseSchema,
  createNoteResponseSchema,
  regenerateNoteResponseSchema,
  noteSummaryResponseSchema,
  noteVersionListResponseSchema,
  noteVersionDetailResponseSchema,
  noteGenerationContextResponseSchema,
  retitleNoteResponseSchema,
  retitleSweepResponseSchema,
  noteConflictSchema,
} from '@marinoscar/kvox-contract/notes';

// The wire schemas of this file moved to `@marinoscar/kvox-contract/notes` (issue #488, file `notes/note.ts`); they are re-exported below so no importer changes.
export {
  MAX_TITLE_CHARS,
  MAX_BODY_CHARS,
  MAX_SUMMARY_CHARS,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  EXCERPT_CHARS,
  RETITLE_SWEEP_LIMIT,
  NOTE_CONFLICT_REASONS,
  type NoteConflictReason,
  noteTitleSourceSchema,
  type NoteTitleSource,
  noteSourceSchema,
  type NoteSourceDto,
  createNoteSchema,
  type CreateNoteDto,
  updateNoteSchema,
  type UpdateNoteDto,
  regenerateNoteSchema,
  type RegenerateNoteDto,
  restoreNoteVersionSchema,
  type RestoreNoteVersionDto,
  noteListQuerySchema,
  type NoteListQueryDto,
  noteVersionsQuerySchema,
  type NoteVersionsQueryDto,
  noteResponseSchema,
  type NoteResponse,
  noteListItemSchema,
  type NoteListItem,
  noteListResponseSchema,
  createNoteResponseSchema,
  regenerateNoteResponseSchema,
  noteSummaryResponseSchema,
  noteVersionSchema,
  noteVersionListResponseSchema,
  noteVersionDetailResponseSchema,
  noteGenerationContextResponseSchema,
  type NoteGenerationContextResponse,
  retitleNoteResponseSchema,
  retitleSweepResponseSchema,
  noteConflictSchema,
} from '@marinoscar/kvox-contract/notes';

export class CreateNoteBodyDto extends createZodDto(createNoteSchema) {}

export class UpdateNoteBodyDto extends createZodDto(updateNoteSchema) {}

export class RegenerateNoteBodyDto extends createZodDto(regenerateNoteSchema) {}

export class RestoreNoteVersionBodyDto extends createZodDto(restoreNoteVersionSchema) {}

export class NoteListQueryParamsDto extends createZodDto(noteListQuerySchema) {}

export class NoteVersionsQueryParamsDto extends createZodDto(noteVersionsQuerySchema) {}

export class NoteDto extends createZodDto(noteResponseSchema) {}

export class NoteListDto extends createZodDto(noteListResponseSchema) {}

export class CreateNoteResultDto extends createZodDto(createNoteResponseSchema) {}

export class RegenerateNoteResultDto extends createZodDto(regenerateNoteResponseSchema) {}

export class NoteSummaryDto extends createZodDto(noteSummaryResponseSchema) {}

export class NoteVersionsDto extends createZodDto(noteVersionListResponseSchema) {}

export class NoteVersionDetailDto extends createZodDto(noteVersionDetailResponseSchema) {}

export class NoteGenerationContextDto extends createZodDto(noteGenerationContextResponseSchema) {}

export class RetitleNoteResultDto extends createZodDto(retitleNoteResponseSchema) {}

export class RetitleSweepResultDto extends createZodDto(retitleSweepResponseSchema) {}

export class NoteConflictDto extends createZodDto(noteConflictSchema) {}
