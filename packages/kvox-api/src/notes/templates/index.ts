// The built-in note templates and the function that seeds them. Pure: no Nest, no Prisma
// client. Imported by the application's seed script as `@marinoscar/kvox-api/notes/templates`.

export { NOTE_BUILTIN_TEMPLATES, type NoteTemplateSeed } from './builtin-templates.js';
export {
  seedNoteTemplates,
  type NoteTemplateSeedDb,
  type SeedNoteTemplatesResult,
} from './seed-note-templates.js';
