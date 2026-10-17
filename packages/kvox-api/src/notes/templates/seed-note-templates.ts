import { NOTE_BUILTIN_TEMPLATES, type NoteTemplateSeed } from './builtin-templates.js';

// =============================================================================
// Seeding the built-in note templates (issue #48, epic #45; moved into the slice by
// issue #495, epic #491)
// =============================================================================
//
// IDEMPOTENT BY EACH TEMPLATE'S OWN FIXED `id` (see `builtin-templates.ts` for why there is
// no slug column to key on instead). `update` re-asserts every seeded field so an edit to the
// seed text (prose or structured field alike) lands on a re-run; `ownerId` is never part of
// `update` because it is never allowed to change: a built-in stays built-in. This never
// touches a user's own duplicate-and-edit copy (`note_templates.duplicate`,
// docs/specs/notes.md §7.3), which always gets a fresh, random `id` distinct from every one
// of these fixed ones.
//
// THE FUNCTION TAKES A STRUCTURAL CLIENT (`NoteTemplateSeedDb`), not a generated one: any
// Prisma client that has the `noteTemplate` model satisfies it, so the application's seed
// script passes its own client and a host with a different driver passes its own.
// =============================================================================

/** The part of a Prisma client {@link seedNoteTemplates} uses. @stability experimental */
/**
 * NoteTemplateSeedDb.
 *
 * @stability experimental
 */
export interface NoteTemplateSeedDb {
  /** `note_templates`. */
  noteTemplate: {
    /** The rows matching (here: the built-ins that already exist). */
    findMany(args?: { where?: any; select?: any }): Promise<
      Array<{
        /** The template's id. */
        id: string;
      }>
    >;
    /** Inserts the row or updates the one with the same key. */
    upsert(args: { where: any; update: any; create: any }): Promise<unknown>;
  };
}

/** What a seed run did. @stability experimental */
/**
 * SeedNoteTemplatesResult.
 *
 * @stability experimental
 */
export interface SeedNoteTemplatesResult {
  /** Built-ins inserted by this run. */
  created: number;
  /** Built-ins that already existed and were re-asserted. */
  updated: number;
}

/**
 * Upserts the built-in note templates. Idempotent: a second run creates nothing.
 *
 * @param db - a Prisma client (or anything with the `noteTemplate` delegate).
 * @param templates - the templates to seed; default {@link NOTE_BUILTIN_TEMPLATES}.
 * @returns how many rows were created and how many already existed.
 * @stability experimental
 */
export async function seedNoteTemplates(
  db: NoteTemplateSeedDb,
  templates: readonly NoteTemplateSeed[] = NOTE_BUILTIN_TEMPLATES,
): Promise<SeedNoteTemplatesResult> {
  const existing = new Set(
    (
      await db.noteTemplate.findMany({
        where: { id: { in: templates.map((template) => template.id) } },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  let created = 0;
  let updated = 0;

  for (const template of templates) {
    await db.noteTemplate.upsert({
      where: { id: template.id },
      update: {
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        outputFormat: template.outputFormat,
        bodyFormat: template.bodyFormat,
        structure: [...template.structure],
        tone: template.tone,
        length: template.length,
      },
      create: {
        id: template.id,
        ownerId: null,
        name: template.name,
        description: template.description,
        instructions: template.instructions,
        outputFormat: template.outputFormat,
        bodyFormat: template.bodyFormat,
        structure: [...template.structure],
        tone: template.tone,
        length: template.length,
      },
    });

    if (existing.has(template.id)) updated += 1;
    else created += 1;
  }

  return { created, updated };
}
